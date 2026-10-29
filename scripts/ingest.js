#!/usr/bin/env node
// Builds data/catalog.json from:
//   1. data/seed.json (hand-curated)
//   2. Claude Code plugin marketplaces (local ~/.claude/plugins clones, else fetched from GitHub)
//   3. Skills inside installed plugins (SKILL.md frontmatter)
//   4. The official MCP Registry
//   5. GitHub topic search: top repos for MCP, Claude Code, Agent Skills, Codex, Gemini CLI,
//      Cursor, Copilot, ChatGPT, agents and prompts (plus Gemini CLI extensions)
//   6. SKILL.md files from Anthropic's/OpenAI's skill catalogs and top community skill repos
//   7. Community Claude Code plugin marketplaces found on GitHub
//   8. GitHub repo stats (stars, last push, license, language, archived)
//
// Usage: node scripts/ingest.js [--offline] [--max-mcp=N] [--max-github=N] [--topic-pages=N] [--skill-repos=N]
// Env:   GITHUB_TOKEN (raises GitHub limits; falls back to `gh auth token` when gh is signed in)
//        CLAUDE_PLUGINS_DIR (defaults to ~/.claude/plugins)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeItem } from "../server/catalog.js";
import { DATA_DIR } from "../server/load.js";
import { parseQuery } from "../server/search.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const OFFLINE = Boolean(args.offline);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ghCliToken();
const MAX_MCP = Number(args["max-mcp"] ?? 10_000);
const MAX_GITHUB = Number(args["max-github"] ?? (GITHUB_TOKEN ? 3000 : 40));
const TOPIC_PAGES = Number(args["topic-pages"] ?? (GITHUB_TOKEN ? 5 : 2));
const MAX_SKILL_REPOS = Number(args["skill-repos"] ?? (GITHUB_TOKEN ? 60 : 15));
const MAX_SKILLS_PER_REPO = 250;
const MIN_STARS = 15;
const PLUGINS_DIR = process.env.CLAUDE_PLUGINS_DIR || path.join(os.homedir(), ".claude", "plugins");
const GITHUB_CACHE_FILE = path.join(DATA_DIR, "github-cache.json");
const GITHUB_CACHE_TTL_MS = 24 * 3600 * 1000;

// Marketplaces to index when there's no local clone. `claude-plugins-official` ships with Claude Code.
const REMOTE_MARKETPLACES = ["anthropics/claude-plugins-official", "affaan-m/ECC", "cloudflare/skills"];
const BUILT_IN_MARKETPLACE = "claude-plugins-official";

const log = (...m) => console.log("[ingest]", ...m);
const warn = (...m) => console.warn("[ingest] WARN", ...m);

/** Reuses a signed-in GitHub CLI's token so ingest gets the 5000 req/hour limit without extra setup. */
function ghCliToken() {
  for (const bin of ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]) {
    try {
      return execFileSync(bin, ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      // not installed or not signed in
    }
  }
  return null;
}

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
// Only the name and first sentence: long SKILL.md descriptions mention everything in passing
// ("...exports to a spreadsheet or database") and tagging all of it made search noisy.
function autoTags(...texts) {
  return parseQuery(texts.filter(Boolean).map(firstSentence).join(" ")).tags;
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

// Sibling manifests that mean a plugin also ships for another agent harness.
const OTHER_HARNESS_DIRS = { ".codex-plugin": "codex", ".cursor-plugin": "cursor", ".gemini-extension": "gemini" };

function otherHarnesses(dir) {
  if (!dir) return [];
  return Object.entries(OTHER_HARNESS_DIRS)
    .filter(([sub]) => fs.existsSync(path.join(dir, sub)))
    .map(([, agent]) => agent);
}

function pluginItems(manifest, marketplaceRepo, localDir) {
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
      alsoFor: p.source === "./" ? otherHarnesses(localDir) : [],
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
    const dir = info.installLocation ?? path.join(PLUGINS_DIR, "marketplaces", name);
    const manifest = readJson(path.join(dir, ".claude-plugin", "marketplace.json"));
    if (!manifest) continue;
    const repo = info.source?.repo ?? githubRepoFromUrl(info.source?.url);
    if (repo) seenRepos.add(repo.toLowerCase());
    manifests.push({ manifest, repo, dir, from: "local" });
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

  const items = manifests.flatMap(({ manifest, repo, dir }) => pluginItems(manifest, repo, dir));
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

// ---------- GitHub API ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GH_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "ai-deck-ingest",
  ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};
const MAX_RATE_WAIT_MS = 75_000;

/** GitHub REST call that waits out short rate-limit windows (the search API resets every minute). */
async function gh(pathname) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.github.com${pathname}`, { headers: GH_HEADERS });
    if (res.ok) return res.json();
    const limited = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
    if (limited) {
      const waitMs = Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now() + 1000;
      if (waitMs > MAX_RATE_WAIT_MS) {
        const error = new Error(`GitHub rate limit (resets in ${Math.round(waitMs / 60000)} min)`);
        error.status = 429;
        throw error;
      }
      log(`GitHub rate limit, waiting ${Math.ceil(waitMs / 1000)}s`);
      await sleep(Math.max(waitMs, 1000));
      continue;
    }
    const error = new Error(`${res.status} ${res.statusText} for ${pathname}`);
    error.status = res.status;
    throw error;
  }
  throw new Error(`GitHub ${pathname}: gave up after retries`);
}

function repoStats(r) {
  return {
    fetchedAt: Date.now(),
    stars: r.stargazers_count,
    forks: r.forks_count,
    pushedAt: r.pushed_at,
    license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
    language: r.language,
    archived: r.archived,
    description: r.description,
    topics: r.topics ?? [],
  };
}

async function mapLimit(list, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]);
      }
    }),
  );
  return out;
}

// ---------- GitHub topic search ----------

const ALL = null; // repo is relevant to every agent
const SKILL_AGENTS = ["claude-code", "claude", "codex", "gemini", "cursor", "copilot", "other"];

// [topic, extra tags, agents]. Sorted by stars, MIN_STARS and up, non-archived, non-fork.
const TOPICS = [
  ["mcp-server", ["mcp"], ALL],
  ["model-context-protocol", ["mcp"], ALL],
  ["mcp", ["mcp"], ALL],
  ["mcp-servers", ["mcp"], ALL],
  ["claude-code", ["claude-code"], ["claude-code"]],
  ["claude-code-plugin", ["plugin", "claude-code"], ["claude-code"]],
  ["claude-code-plugins", ["plugin", "claude-code"], ["claude-code"]],
  ["claude-skills", ["skills"], SKILL_AGENTS],
  ["agent-skills", ["skills"], SKILL_AGENTS],
  ["claude-ai", ["claude"], ["claude-code", "claude"]],
  ["anthropic-claude", ["claude"], ["claude-code", "claude"]],
  ["openai-codex", ["codex"], ["codex"]],
  ["codex-cli", ["codex"], ["codex"]],
  ["gemini-cli", ["gemini"], ["gemini"]],
  ["gemini-cli-extension", ["gemini", "extension"], ["gemini"]],
  ["gemini-cli-extensions", ["gemini", "extension"], ["gemini"]],
  ["cursor-rules", ["cursor", "rules"], ["cursor"]],
  ["cursorrules", ["cursor", "rules"], ["cursor"]],
  ["cursor-ai", ["cursor"], ["cursor"]],
  ["github-copilot", ["copilot"], ["copilot"]],
  ["copilot-instructions", ["copilot"], ["copilot"]],
  ["chatgpt", ["chatgpt"], ["chatgpt"]],
  ["custom-gpt", ["chatgpt", "gpts"], ["chatgpt"]],
  ["gpts", ["chatgpt", "gpts"], ["chatgpt"]],
  ["chatgpt-prompts", ["prompts", "chatgpt"], ["chatgpt"]],
  ["prompt-engineering", ["prompts"], ALL],
  ["prompts", ["prompts"], ALL],
  ["ai-agents", ["agents"], ALL],
  ["ai-agent", ["agents"], ALL],
  ["llm-tools", ["tools"], ALL],
  ["vibe-coding", ["coding"], ALL],
];

async function loadTopicRepos() {
  if (OFFLINE) return { repos: new Map(), byTopic: new Map() };
  const repos = new Map(); // full_name lowercased -> { r, tags:Set, agents:Set|null }
  const byTopic = new Map();
  for (const [topic, tags, agents] of TOPICS) {
    const found = [];
    for (let page = 1; page <= TOPIC_PAGES; page++) {
      let res;
      try {
        res = await gh(`/search/repositories?q=${encodeURIComponent(`topic:${topic} stars:>=${MIN_STARS} archived:false`)}&sort=stars&order=desc&per_page=100&page=${page}`);
      } catch (error) {
        warn(`topic ${topic}: ${error.message}`);
        break;
      }
      for (const r of res.items ?? []) {
        if (r.fork) continue;
        const key = r.full_name.toLowerCase();
        const entry = repos.get(key) ?? { r, tags: new Set(), agents: new Set() };
        tags.forEach((t) => entry.tags.add(t));
        if (agents === ALL) entry.agents = null;
        else if (entry.agents) agents.forEach((a) => entry.agents.add(a));
        repos.set(key, entry);
        found.push(r);
      }
      if ((res.items ?? []).length < 100) break;
    }
    byTopic.set(topic, found);
  }
  log(`GitHub topics: ${repos.size} unique repos across ${TOPICS.length} topics`);
  return { repos, byTopic };
}

function topicRepoItems(repos) {
  return [...repos.values()]
    .filter(({ r }) => r.description)
    .map(({ r, tags, agents }) => ({
      id: `repo:${r.full_name}`,
      type: "repo",
      name: r.name,
      summary: firstSentence(r.description),
      description: r.description.slice(0, 400),
      tags: [...tags, ...(r.topics ?? []).slice(0, 8), ...autoTags(r.name.replace(/[-_]/g, " "), r.description)],
      useCases: [],
      repo: r.full_name,
      author: r.owner?.login,
      ...(agents ? { agents: [...agents] } : {}),
      source: "github-topic",
    }));
}

/** Gemini CLI extensions install straight from their GitHub URL. */
function geminiExtensionItems(byTopic) {
  const seen = new Set();
  const items = [];
  for (const topic of ["gemini-cli-extension", "gemini-cli-extensions"]) {
    for (const r of byTopic.get(topic) ?? []) {
      if (seen.has(r.full_name) || !r.description) continue;
      seen.add(r.full_name);
      items.push({
        id: `plugin:gemini:${r.full_name}`,
        type: "plugin",
        name: r.name,
        summary: firstSentence(r.description),
        description: r.description.slice(0, 400),
        tags: ["gemini", "extension", ...autoTags(r.name.replace(/[-_]/g, " "), r.description)],
        useCases: [],
        repo: r.full_name,
        author: r.owner?.login,
        agentInstalls: { gemini: { kind: "command", where: "terminal", value: `gemini extensions install https://github.com/${r.full_name}` } },
        source: "gemini-extension",
      });
    }
  }
  log(`Gemini CLI extensions: ${items.length}`);
  return items;
}

// ---------- SKILL.md files on GitHub ----------

const SKILL_CATALOG_REPOS = ["anthropics/skills", "openai/skills"];

async function loadGitHubSkills(byTopic, skipRepos) {
  if (OFFLINE || MAX_SKILL_REPOS <= 0) return [];
  const candidates = [
    ...SKILL_CATALOG_REPOS,
    ...[...(byTopic.get("agent-skills") ?? []), ...(byTopic.get("claude-skills") ?? [])]
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .map((r) => r.full_name),
  ];
  const repos = [...new Set(candidates)].filter((r) => !skipRepos.has(r.toLowerCase())).slice(0, MAX_SKILL_REPOS);

  const items = [];
  for (const repo of repos) {
    let tree;
    try {
      tree = await gh(`/repos/${repo}/git/trees/HEAD?recursive=1`);
    } catch (error) {
      warn(`skills ${repo}: ${error.message}`);
      if (error.status === 429) break;
      continue;
    }
    const paths = (tree.tree ?? [])
      .filter((n) => n.type === "blob" && /(^|\/)SKILL\.md$/i.test(n.path))
      .map((n) => n.path)
      .slice(0, MAX_SKILLS_PER_REPO);
    const found = await mapLimit(paths, 12, async (p) => {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${p.split("/").map(encodeURIComponent).join("/")}`);
        if (!res.ok) return null;
        const fm = parseFrontmatter(await res.text());
        if (!fm.description) return null;
        const dir = p.replace(/\/?SKILL\.md$/i, "");
        const name = fm.name || dir.split("/").pop() || repo.split("/")[1];
        return {
          id: `skill:gh:${repo}:${dir || name}`,
          type: "skill",
          name,
          summary: firstSentence(fm.description),
          description: fm.description.slice(0, 400),
          tags: [repo.split("/")[1].toLowerCase(), ...autoTags(name.replace(/-/g, " "), fm.description)],
          useCases: [],
          author: repo.split("/")[0],
          repo,
          url: `https://github.com/${repo}/tree/HEAD/${dir}`,
          skillDir: dir,
          official: SKILL_CATALOG_REPOS.includes(repo),
          source: "github-skill",
        };
      } catch {
        return null;
      }
    });
    const ok = found.filter(Boolean);
    items.push(...ok);
    log(`  skills ${repo}: ${ok.length}`);
  }
  log(`GitHub skills: ${items.length} from ${repos.length} repos`);
  return items;
}

// ---------- community plugin marketplaces ----------

async function loadCommunityMarketplaces(byTopic, skipRepos) {
  if (OFFLINE) return [];
  const repos = [...(byTopic.get("claude-code-plugin") ?? []), ...(byTopic.get("claude-code-plugins") ?? []), ...(byTopic.get("claude-code") ?? [])]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .map((r) => r.full_name)
    .filter((r, i, all) => all.indexOf(r) === i && !skipRepos.has(r.toLowerCase()))
    .slice(0, GITHUB_TOKEN ? 150 : 60);
  const manifests = await mapLimit(repos, 12, async (repo) => {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`);
      if (!res.ok) return null;
      const manifest = await res.json();
      return manifest?.name && Array.isArray(manifest.plugins) ? { manifest, repo } : null;
    } catch {
      return null;
    }
  });
  const found = manifests.filter(Boolean);
  const items = found.flatMap(({ manifest, repo }) => pluginItems(manifest, repo, null).map((p) => ({ ...p, source: "community-marketplace" })));
  log(`community marketplaces: ${found.length} of ${repos.length} repos -> ${items.length} plugins`);
  return items;
}

// ---------- GitHub stats ----------

async function enrichFromGitHub(items, topicRepos) {
  const cache = readJson(GITHUB_CACHE_FILE, {});
  // Topic search already returned full repo objects; reuse them instead of spending API calls.
  for (const [key, { r }] of topicRepos) cache[key] = repoStats(r);
  const repos = [...new Set(items.map((i) => i.repo).filter(Boolean).map((r) => r.toLowerCase()))];
  const now = Date.now();
  const stale = repos.filter((r) => !cache[r] || now - cache[r].fetchedAt > GITHUB_CACHE_TTL_MS);

  let fetched = 0;
  if (!OFFLINE) {
    for (const repo of stale.slice(0, MAX_GITHUB)) {
      try {
        cache[repo] = repoStats(await gh(`/repos/${repo}`));
        fetched++;
      } catch (error) {
        if (error.status === 404) {
          cache[repo] = { fetchedAt: now, missing: true };
        } else if (error.status === 429) {
          warn(`GitHub rate limit reached after ${fetched} repos; sign in with gh or set GITHUB_TOKEN for more`);
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

  log(GITHUB_TOKEN ? "GitHub: authenticated" : "GitHub: anonymous (low limits; sign in with gh or set GITHUB_TOKEN for a much bigger catalog)");
  const { items: plugins, manifests } = await loadMarketplaces();
  const skills = loadInstalledSkills(manifests);
  const mcp = await loadMcpRegistry();
  const { repos: topicRepos, byTopic } = await loadTopicRepos();
  const knownMarketplaceRepos = new Set(manifests.map((m) => m.repo?.toLowerCase()).filter(Boolean));
  const ghSkills = await loadGitHubSkills(byTopic, knownMarketplaceRepos);
  const communityPlugins = await loadCommunityMarketplaces(byTopic, knownMarketplaceRepos);

  const merged = new Map();
  const add = (item) => {
    if (!merged.has(item.id)) merged.set(item.id, item);
  };
  seedItems.forEach(add);
  plugins.filter((p) => !seedInstalls.has(`${p.name}@${p.marketplace}`)).forEach(add);
  skills.forEach(add);
  ghSkills.forEach(add);
  communityPlugins.forEach(add);
  geminiExtensionItems(byTopic).forEach(add);
  // Seed entries carry hand-written beginner copy; prefer them over registry duplicates of the same repo.
  mcp.filter((m) => !(m.repo && seedRegistryRepos.has(m.repo.toLowerCase()))).forEach(add);
  topicRepoItems(topicRepos).forEach(add);

  const items = [...merged.values()];
  await enrichFromGitHub(items, topicRepos);
  for (const item of items) item.tags = [...new Set(item.tags.map((t) => String(t).toLowerCase()))].slice(0, 16);

  const valid = items.filter((i) => normalizeItem(i));
  const sources = valid.reduce((acc, i) => ({ ...acc, [i.source]: (acc[i.source] ?? 0) + 1 }), {});
  const out = { generatedAt: new Date().toISOString(), sources, items: valid };
  fs.writeFileSync(path.join(DATA_DIR, "catalog.json"), JSON.stringify(out));
  log(`wrote data/catalog.json: ${valid.length} items`, sources);
}

// Run only when executed directly, so tests can import the parsers.
if (process.argv[1]?.endsWith("ingest.js")) {
  main().catch((error) => {
    console.error("[ingest] failed:", error);
    process.exit(1);
  });
}
