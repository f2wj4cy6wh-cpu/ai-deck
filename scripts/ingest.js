#!/usr/bin/env node
// Builds data/catalog.json from:
//   1. data/seed.json (hand-curated)
//   2. Claude Code plugin marketplaces (local ~/.claude/plugins clones, else fetched from GitHub)
//   3. Skills inside installed plugins (SKILL.md frontmatter)
//   4. The official MCP Registry
//   5. GitHub repo stats (stars, last push, license, language, archived)
//
// Usage: node scripts/ingest.js [--offline] [--max-mcp=400] [--max-github=60]
// Env:   GITHUB_TOKEN (raises the GitHub limit from 60 to 5000 requests/hour)
//        CLAUDE_PLUGINS_DIR (defaults to ~/.claude/plugins)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, normalizeItem } from "../server/catalog.js";
import { parseQuery } from "../server/search.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const OFFLINE = Boolean(args.offline);
const MAX_MCP = Number(args["max-mcp"] ?? 400);
const MAX_GITHUB = Number(args["max-github"] ?? (process.env.GITHUB_TOKEN ? 1500 : 55));
const PLUGINS_DIR = process.env.CLAUDE_PLUGINS_DIR || path.join(os.homedir(), ".claude", "plugins");
const GITHUB_CACHE_FILE = path.join(DATA_DIR, "github-cache.json");
const GITHUB_CACHE_TTL_MS = 24 * 3600 * 1000;

// Marketplaces to index when there's no local clone. `claude-plugins-official` ships with Claude Code.
const REMOTE_MARKETPLACES = ["anthropics/claude-plugins-official", "affaan-m/ECC", "cloudflare/skills"];
const BUILT_IN_MARKETPLACE = "claude-plugins-official";

const log = (...m) => console.log("[ingest]", ...m);
const warn = (...m) => console.warn("[ingest] WARN", ...m);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function githubRepoFromUrl(url) {
  const m = String(url ?? "").match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Adds tags implied by the description, so marketplace items are findable by plain-English intent. */
function autoTags(...texts) {
  return parseQuery(texts.filter(Boolean).join(" ")).tags;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": "ai-deck-ingest", ...headers } });
  if (!res.ok) {
    const error = new Error(`${res.status} ${res.statusText} for ${url}`);
    error.status = res.status;
    error.headers = res.headers;
    throw error;
  }
  return res.json();
}

// ---------- marketplaces ----------

function marketplaceInstall(pluginName, marketplaceName, marketplaceRepo) {
  const install = `/plugin install ${pluginName}@${marketplaceName}`;
  if (marketplaceName === BUILT_IN_MARKETPLACE || !marketplaceRepo) return install;
  return `/plugin marketplace add ${marketplaceRepo}\n${install}`;
}

function pluginItems(manifest, marketplaceRepo) {
  const mkt = manifest.name;
  return (manifest.plugins ?? []).map((p) => {
    const sourceUrl = typeof p.source === "object" ? p.source.url ?? (p.source.repo && `https://github.com/${p.source.repo}`) : null;
    const repo = githubRepoFromUrl(p.repository) || githubRepoFromUrl(sourceUrl) || (p.source === "./" ? marketplaceRepo : null);
    const keywords = [...(p.keywords ?? []), ...(p.tags ?? []), p.category].filter(Boolean);
    return {
      id: `plugin:${p.name}@${mkt}`,
      type: "plugin",
      name: p.name,
      summary: firstSentence(p.description),
      description: p.description ?? "",
      tags: [...keywords, ...autoTags(p.name, p.description)],
      useCases: [],
      category: p.category ?? null,
      author: typeof p.author === "object" ? p.author?.name : p.author,
      license: p.license ?? null,
      homepage: p.homepage ?? null,
      repo,
      marketplace: mkt,
      install: { command: marketplaceInstall(p.name, mkt, marketplaceRepo) },
      official: mkt === BUILT_IN_MARKETPLACE && /anthropic/i.test(JSON.stringify(p.author ?? "")),
      source: `marketplace:${mkt}`,
    };
  });
}

function firstSentence(text) {
  const s = String(text ?? "").trim();
  const m = s.match(/^(.{20,220}?[.!?])(\s|$)/);
  if (m) return m[1];
  return s.length > 220 ? `${s.slice(0, 217).replace(/\s+\S*$/, "")}…` : s;
}

async function loadMarketplaces() {
  const known = readJson(path.join(PLUGINS_DIR, "known_marketplaces.json"), {});
  const manifests = [];
  const seenRepos = new Set();

  for (const [name, info] of Object.entries(known)) {
    const file = path.join(info.installLocation ?? path.join(PLUGINS_DIR, "marketplaces", name), ".claude-plugin", "marketplace.json");
    const manifest = readJson(file);
    if (!manifest) continue;
    const repo = info.source?.repo ?? githubRepoFromUrl(info.source?.url);
    if (repo) seenRepos.add(repo.toLowerCase());
    manifests.push({ manifest, repo, from: "local" });
  }

  if (!OFFLINE) {
    for (const repo of REMOTE_MARKETPLACES) {
      if (seenRepos.has(repo.toLowerCase())) continue;
      try {
        const manifest = await fetchJson(`https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`);
        manifests.push({ manifest, repo, from: "github" });
      } catch (error) {
        warn(`marketplace ${repo}: ${error.message}`);
      }
    }
  }

  const items = manifests.flatMap(({ manifest, repo }) => pluginItems(manifest, repo));
  log(`marketplaces: ${manifests.length} (${manifests.map((m) => `${m.manifest.name}:${m.from}`).join(", ")}) -> ${items.length} plugins`);
  return { items, manifests };
}

// ---------- skills inside installed plugins ----------

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ");
    }
    out[key] = value.replace(/^["']|["']$/g, "").replace(/\\"/g, '"');
  }
  return out;
}

function latestVersionDir(pluginDir) {
  const versions = fs
    .readdirSync(pluginDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: path.join(pluginDir, d.name), mtime: fs.statSync(path.join(pluginDir, d.name)).mtimeMs }));
  versions.sort((a, b) => b.mtime - a.mtime);
  return versions[0]?.dir ?? null;
}

function loadInstalledSkills(manifests) {
  const cacheDir = path.join(PLUGINS_DIR, "cache");
  if (!fs.existsSync(cacheDir)) return [];
  const repoByMarketplace = new Map(manifests.map(({ manifest, repo }) => [manifest.name, repo]));
  const items = [];

  for (const mkt of fs.readdirSync(cacheDir)) {
    const mktDir = path.join(cacheDir, mkt);
    if (!fs.statSync(mktDir).isDirectory()) continue;
    for (const plugin of fs.readdirSync(mktDir)) {
      const versionDir = latestVersionDir(path.join(mktDir, plugin));
      const skillsDir = versionDir && path.join(versionDir, "skills");
      if (!skillsDir || !fs.existsSync(skillsDir)) continue;
      for (const skill of fs.readdirSync(skillsDir)) {
        const file = path.join(skillsDir, skill, "SKILL.md");
        if (!fs.existsSync(file)) continue;
        const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
        const name = fm.name || skill;
        if (!fm.description) continue;
        items.push({
          id: `skill:${plugin}:${name}`,
          type: "skill",
          name,
          summary: firstSentence(fm.description),
          description: fm.description,
          tags: [plugin, ...autoTags(name.replace(/-/g, " "), fm.description)],
          useCases: [],
          author: plugin,
          plugin: `${plugin}@${mkt}`,
          repo: repoByMarketplace.get(mkt) ?? null,
          install: {
            command: marketplaceInstall(plugin, mkt, repoByMarketplace.get(mkt)),
            steps: [`Install the ${plugin} plugin`, `Claude uses the skill automatically when it fits, or type /${plugin}:${name}`],
          },
          source: `skill:${mkt}`,
        });
      }
    }
  }
  log(`installed plugin skills: ${items.length}`);
  return items;
}

// ---------- MCP Registry ----------

const GENERIC_NAME_PARTS = new Set(["io", "com", "ai", "ac", "sh", "dev", "app", "net", "org", "co", "github", "gitlab", "mcp", "www"]);

/** "io.github.acme/weather-mcp" -> "weather"; "ac.inference.sh/mcp" -> "inference". */
export function shortName(registryName) {
  const [namespace, last = ""] = registryName.split("/");
  const fromLast = last.replace(/^mcp-?server-?|-?mcp-?server$|^mcp-|-?mcp$/gi, "").replace(/[^\w-]/g, "");
  if (fromLast) return fromLast.toLowerCase();
  const parts = namespace.split(".").filter((p) => !GENERIC_NAME_PARTS.has(p.toLowerCase()));
  return (parts.sort((a, b) => b.length - a.length)[0] || "server").toLowerCase();
}

export function registryInstall(server) {
  const name = shortName(server.name);
  const remote = server.remotes?.[0];
  if (remote?.url) {
    const transport = remote.type === "sse" ? "sse" : "http";
    return `claude mcp add --transport ${transport} ${name} ${remote.url}`;
  }
  const pkg = server.packages?.[0];
  if (!pkg?.identifier) return null;
  const type = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name;
  if (type === "npm") return `claude mcp add ${name} -- npx -y ${pkg.identifier}`;
  if (type === "pypi") return `claude mcp add ${name} -- uvx ${pkg.identifier}`;
  if (type === "oci" || type === "docker") return `claude mcp add ${name} -- docker run -i --rm ${pkg.identifier}`;
  return null;
}

async function loadMcpRegistry() {
  if (OFFLINE || MAX_MCP <= 0) return [];
  const byName = new Map();
  let cursor = null;
  try {
    while (byName.size < MAX_MCP) {
      const url = new URL("https://registry.modelcontextprotocol.io/v0/servers");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = await fetchJson(url);
      for (const entry of page.servers ?? []) {
        const server = entry.server ?? entry;
        const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
        if (meta && meta.isLatest === false) continue;
        if (server.status === "deleted" || meta?.status === "deleted") continue;
        byName.set(server.name, server);
      }
      cursor = page.metadata?.nextCursor ?? page.metadata?.next_cursor;
      if (!cursor) break;
    }
  } catch (error) {
    warn(`MCP registry: ${error.message}`);
  }

  const items = [];
  for (const server of [...byName.values()].slice(0, MAX_MCP)) {
    const command = registryInstall(server);
    if (!command) continue;
    const envVars = (server.packages ?? []).flatMap((p) => p.environmentVariables ?? p.environment_variables ?? []);
    const requires = envVars.filter((v) => v.isRequired ?? v.is_required).map((v) => v.name);
    const headers = (server.remotes ?? []).flatMap((r) => r.headers ?? []).filter((h) => h.isRequired ?? h.is_required);
    requires.push(...headers.map((h) => `${h.name} header`));
    items.push({
      id: `mcp:registry:${server.name}`,
      type: "mcp",
      name: server.title || (/^(mcp|server|mcp-server)$/i.test(server.name.split("/").pop()) ? shortName(server.name) : server.name.split("/").pop()),
      summary: firstSentence(server.description),
      description: server.description ?? "",
      tags: autoTags(server.name.replace(/[/.-]/g, " "), server.description),
      useCases: [],
      requires,
      registryName: server.name,
      version: server.version ?? null,
      repo: githubRepoFromUrl(server.repository?.url),
      homepage: server.websiteUrl ?? null,
      install: { command },
      source: "mcp-registry",
    });
  }
  log(`MCP registry: ${items.length} servers`);
  return items;
}

// ---------- GitHub stats ----------

async function enrichFromGitHub(items) {
  const cache = readJson(GITHUB_CACHE_FILE, {});
  const repos = [...new Set(items.map((i) => i.repo).filter(Boolean).map((r) => r.toLowerCase()))];
  const now = Date.now();
  const stale = repos.filter((r) => !cache[r] || now - cache[r].fetchedAt > GITHUB_CACHE_TTL_MS);
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let fetched = 0;
  if (!OFFLINE) {
    for (const repo of stale.slice(0, MAX_GITHUB)) {
      try {
        const r = await fetchJson(`https://api.github.com/repos/${repo}`, headers);
        cache[repo] = {
          fetchedAt: now,
          stars: r.stargazers_count,
          forks: r.forks_count,
          pushedAt: r.pushed_at,
          license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
          language: r.language,
          archived: r.archived,
          description: r.description,
          topics: r.topics ?? [],
        };
        fetched++;
      } catch (error) {
        if (error.status === 404) {
          cache[repo] = { fetchedAt: now, missing: true };
        } else if (error.status === 403 || error.status === 429) {
          warn(`GitHub rate limit reached after ${fetched} repos; set GITHUB_TOKEN for more`);
          break;
        } else {
          warn(`GitHub ${repo}: ${error.message}`);
        }
      }
    }
    fs.writeFileSync(GITHUB_CACHE_FILE, JSON.stringify(cache));
  }
  log(`GitHub: ${repos.length} repos, ${fetched} fetched now, ${stale.length - fetched > 0 ? stale.length - fetched : 0} still unfetched`);

  for (const item of items) {
    const stats = item.repo && cache[item.repo.toLowerCase()];
    if (!stats || stats.missing) continue;
    item.stars = stats.stars;
    item.forks = stats.forks;
    item.pushedAt = stats.pushedAt;
    item.license ??= stats.license;
    item.archived = stats.archived;
    if (item.type === "repo") {
      item.language = stats.language;
      item.description ||= stats.description ?? "";
      item.tags = [...item.tags, ...stats.topics.slice(0, 6)];
    }
  }
}

// ---------- merge ----------

async function main() {
  const seed = readJson(path.join(DATA_DIR, "seed.json"));
  if (!seed) throw new Error("data/seed.json is missing or invalid");
  const seedItems = seed.items.map((i) => ({ ...i, source: "seed" }));
  const seedInstalls = new Set(seedItems.map((i) => i.install?.command).filter(Boolean).flatMap((c) => c.match(/[\w-]+@[\w-]+/g) ?? []));
  const seedRegistryRepos = new Set(seedItems.filter((i) => i.type === "mcp" && i.repo).map((i) => i.repo.toLowerCase()));

  const { items: plugins, manifests } = await loadMarketplaces();
  const skills = loadInstalledSkills(manifests);
  const mcp = await loadMcpRegistry();

  const merged = new Map();
  const add = (item) => {
    if (!merged.has(item.id)) merged.set(item.id, item);
  };
  seedItems.forEach(add);
  plugins.filter((p) => !seedInstalls.has(`${p.name}@${p.marketplace}`)).forEach(add);
  skills.forEach(add);
  // Seed entries carry hand-written beginner copy; prefer them over registry duplicates of the same repo.
  mcp.filter((m) => !(m.repo && seedRegistryRepos.has(m.repo.toLowerCase()))).forEach(add);

  const items = [...merged.values()];
  await enrichFromGitHub(items);
  for (const item of items) item.tags = [...new Set(item.tags.map((t) => String(t).toLowerCase()))];

  const valid = items.filter((i) => normalizeItem(i));
  const sources = valid.reduce((acc, i) => ({ ...acc, [i.source]: (acc[i.source] ?? 0) + 1 }), {});
  const out = { generatedAt: new Date().toISOString(), sources, items: valid };
  fs.writeFileSync(path.join(DATA_DIR, "catalog.json"), JSON.stringify(out, null, 1));
  log(`wrote data/catalog.json: ${valid.length} items`, sources);
}

// Run only when executed directly, so tests can import the parsers.
if (process.argv[1]?.endsWith("ingest.js")) {
  main().catch((error) => {
    console.error("[ingest] failed:", error);
    process.exit(1);
  });
}
