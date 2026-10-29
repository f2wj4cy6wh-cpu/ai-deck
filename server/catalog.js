// Runtime-neutral catalog logic (no filesystem), shared by the Node server and the Worker.
// File loading lives in load.js.
import { applyAgentSupport } from "./agents.js";

export const TYPES = ["skill", "plugin", "mcp", "repo", "prompt"];
export const LEVELS = ["beginner", "intermediate", "expert"];

// Publishers whose packages we treat as first-party for the trust score.
const OFFICIAL_OWNERS = new Set([
  "anthropics",
  "modelcontextprotocol",
  "microsoft",
  "github",
  "chromedevtools",
  "cloudflare",
  "getsentry",
  "stripe",
  "makenotion",
  "supabase-community",
]);

/** Builds the in-memory catalog from parsed catalog.json / seed.json contents. */
export function buildCatalog(raw, sourceName) {
  const items = dedupe((raw.items ?? []).map(normalizeItem).filter(Boolean));
  return {
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    source: sourceName,
    generatedAt: raw.generatedAt ?? null,
    sources: raw.sources ?? null,
  };
}

/**
 * Lays the current seed over an ingested catalog, so curated edits show up without a re-ingest.
 * Same rule as ingest: a seed MCP server replaces registry listings of the same repo.
 */
export function mergeSeed(raw, seed) {
  // Seed fields win, but keep what ingest added to its copy (GitHub stars, last push, license).
  const ingested = new Map((raw.items ?? []).map((i) => [i.id, i]));
  const seedItems = (seed?.items ?? []).map((i) => ({ ...ingested.get(i.id), ...i, source: "seed" }));
  const ids = new Set(seedItems.map((i) => i.id));
  const mcpRepos = new Set(seedItems.filter((i) => i.type === "mcp" && i.repo).map((i) => i.repo.toLowerCase()));
  const rest = (raw.items ?? []).filter((i) => !ids.has(i.id) && !(i.type === "mcp" && i.source !== "seed" && i.repo && mcpRepos.has(i.repo.toLowerCase())));
  return { ...raw, items: [...seedItems, ...rest] };
}

const rank = (item) => [item.curated ? 1 : 0, item.official ? 1 : 0, item.stars ?? -1, item.trust.score];
function better(a, b) {
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
  return false;
}

/**
 * Collapses copies of the same skill/server republished across repos (same type, name and summary),
 * and drops a repo card when a few (up to 3) plugins or MCP servers install that same repo: the
 * installable entry says everything the repo card would, plus how to add it.
 */
export function dedupe(items) {
  const installers = new Map();
  for (const item of items) {
    if ((item.type === "plugin" || item.type === "mcp") && item.repo) {
      const key = item.repo.toLowerCase();
      installers.set(key, (installers.get(key) ?? 0) + 1);
    }
  }
  items = items.filter((item) => item.type !== "repo" || !item.repo || !(installers.get(item.repo.toLowerCase()) <= 3));

  const best = new Map();
  for (const item of items) {
    const key = `${item.type}|${item.name.toLowerCase()}|${(item.summary || item.description).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60)}`;
    const current = best.get(key);
    if (!current || better(item, current)) best.set(key, item);
  }
  const keep = new Set(best.values());
  return items.filter((item) => keep.has(item));
}

// Names that say nothing on a card ("mcp", "cli"): shown as owner/repo instead.
const VAGUE_NAME = /^(server|mcp|mcp[-_]server|cli|app|main|src|core|skills?|plugins?|extensions?|agents?|tools?|ai)$/i;

export function normalizeItem(item) {
  if (!item?.id || !item?.name || !TYPES.includes(item.type)) return null;
  const owner = item.repo?.split("/")[0]?.toLowerCase();
  const normalized = {
    tags: [],
    useCases: [],
    requires: [],
    summary: "",
    description: "",
    ...item,
    name: VAGUE_NAME.test(item.name) && item.repo ? item.repo : item.name,
    level: LEVELS.includes(item.level) ? item.level : inferLevel(item),
    official: Boolean(item.official || (owner && OFFICIAL_OWNERS.has(owner))),
    curated: Boolean(item.curated || item.source === "seed"),
  };
  normalized.tags = [...new Set(normalized.tags.map((t) => String(t).toLowerCase()))];
  normalized.url ??= item.repo ? `https://github.com/${item.repo}` : item.homepage ?? null;
  normalized.trust = trustScore(normalized);
  return applyAgentSupport(normalized);
}

/** Heuristic difficulty when the source didn't give one: anything needing keys or tokens is not beginner-grade. */
export function inferLevel(item) {
  const needs = (item.requires ?? []).join(" ").toLowerCase();
  const text = `${item.description ?? ""} ${item.summary ?? ""}`.toLowerCase();
  if (/kubernetes|terraform|graph orchestration|low-level|sdk for building/.test(text)) return "expert";
  if (/token|api key|account|docker|oauth/.test(needs)) return "intermediate";
  if (item.type === "repo") return "intermediate";
  return "beginner";
}

/**
 * 0-100 score from objective signals only (never from model output), shown as the trust badge.
 * Unknown signals (no GitHub stats fetched yet) score neutral rather than zero.
 */
export function trustScore(item) {
  let score = 40;
  const reasons = [];
  if (item.official) {
    score += 25;
    reasons.push("official publisher");
  }
  if (typeof item.stars === "number") {
    const starPoints = Math.min(20, Math.round(Math.log10(item.stars + 1) * 5));
    score += starPoints;
    if (item.stars >= 1000) reasons.push(`${formatCount(item.stars)} stars`);
  }
  if (item.pushedAt) {
    const days = (Date.now() - Date.parse(item.pushedAt)) / 86_400_000;
    if (days < 90) {
      score += 10;
      reasons.push("updated recently");
    } else if (days > 365) {
      score -= 15;
      reasons.push("no updates in a year");
    }
  }
  if (item.license) score += 5;
  if (item.archived) {
    score -= 40;
    reasons.push("archived");
  }
  if (item.source === "mcp-registry" && !item.official) reasons.push("community listing");
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function catalogStats(catalog) {
  const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const item of catalog.items) counts[item.type] += 1;
  return { counts, total: catalog.items.length, source: catalog.source, generatedAt: catalog.generatedAt };
}
