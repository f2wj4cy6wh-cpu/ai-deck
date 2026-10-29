import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, "..", "data");

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Loads data/catalog.json (written by `npm run ingest`), falling back to the seed. */
export function loadCatalog(dataDir = DATA_DIR, { seedOnly = false } = {}) {
  const catalogFile = path.join(dataDir, "catalog.json");
  const seedFile = path.join(dataDir, "seed.json");
  const source = !seedOnly && fs.existsSync(catalogFile) ? catalogFile : seedFile;
  const raw = readJson(source);
  const items = (raw.items ?? []).map(normalizeItem).filter(Boolean);
  return {
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    source: path.basename(source),
    generatedAt: raw.generatedAt ?? null,
    sources: raw.sources ?? null,
  };
}

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
    level: LEVELS.includes(item.level) ? item.level : inferLevel(item),
    official: Boolean(item.official || (owner && OFFICIAL_OWNERS.has(owner))),
  };
  normalized.tags = [...new Set(normalized.tags.map((t) => String(t).toLowerCase()))];
  normalized.url ??= item.repo ? `https://github.com/${item.repo}` : item.homepage ?? null;
  normalized.trust = trustScore(normalized);
  return normalized;
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
