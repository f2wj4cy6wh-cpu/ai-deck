import { test } from "node:test";
import assert from "node:assert/strict";
import { trustScore, normalizeItem, dedupe, mergeSeed } from "../server/catalog.js";
import { loadCatalog } from "../server/load.js";
import { parseClaudeMcpAdd, agentInQuery, AGENTS } from "../server/agents.js";
import { buildIndex, search, parseQuery, tokenize, cleanAutoTags } from "../server/search.js";
import { githubRepoFromUrl, parseFrontmatter, registryInstall, shortName } from "../scripts/ingest.js";

// Ranking tests run against the hand-curated seed so they don't depend on live ingest data.
const catalog = loadCatalog(undefined, { seedOnly: true });
const index = buildIndex(catalog.items);

const top = (q, opts = {}, n = 3) => search(index, { q, ...opts }).results.slice(0, n).map((r) => r.item.id);

// Golden queries: plain-English request -> an id that must appear in the top 3.
const GOLDEN = [
  ["let claude use my web browser", "mcp:playwright"],
  ["make slides from my notes", "skill:anthropic-document-skills"],
  ["build an excel spreadsheet", "skill:anthropic-document-skills"],
  ["why does my app keep crashing", "mcp:sentry"],
  ["up to date documentation for a library", "mcp:context7"],
  ["review my pull requests on github", "mcp:github"],
  ["make claude remember things between chats", "mcp:memory"],
  ["run ai models offline on my laptop", "repo:ollama/ollama"],
  ["explain this code simply, i am new to coding", "prompt:explain-for-juniors"],
  ["accept payments", "mcp:stripe"],
  ["connect to my postgres database", "mcp:supabase"],
];

for (const [query, expected] of GOLDEN) {
  test(`golden: "${query}" -> ${expected}`, () => {
    assert.ok(top(query).includes(expected), `top 3 was ${top(query).join(", ")}`);
  });
}

test("type filter only returns that type", () => {
  const { results } = search(index, { q: "github", type: "repo" });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.item.type === "repo"));
});

test("query naming a type boosts that type", () => {
  const { results } = search(index, { q: "browser mcp server" });
  assert.equal(results[0].item.type, "mcp");
});

test("beginner mode demotes expert items relative to expert mode", () => {
  const rank = (level) => search(index, { q: "agent framework", level }).results.findIndex((r) => r.item.id === "repo:langchain-ai/langgraph");
  assert.ok(rank("expert") <= rank("beginner"));
});

test("nonsense query returns nothing instead of everything", () => {
  assert.equal(search(index, { q: "zzqxv flurbo" }).total, 0);
});

test("empty query lists items ordered by trust", () => {
  const { results } = search(index, { q: "" });
  assert.equal(results.length > 0, true);
  assert.ok(results[0].item.trust.score >= results.at(-1).item.trust.score);
});

test("intent patterns are word-anchored", () => {
  assert.ok(!parseQuery("display the latest platform").tags.includes("payments"));
  assert.ok(!parseQuery("display the latest platform").tags.includes("testing"));
  assert.ok(parseQuery("write tests for my api").tags.includes("testing"));
});

test("tokenize drops stopwords and stems", () => {
  assert.deepEqual(tokenize("I want to run the tests"), ["run", "test"]);
});

test("trust score rewards official + stars, penalizes archived", () => {
  const base = { id: "x", type: "repo", name: "x", tags: [] };
  const official = trustScore({ ...base, official: true, stars: 50_000 }).score;
  const unknown = trustScore(base).score;
  const archived = trustScore({ ...base, archived: true }).score;
  assert.ok(official > unknown && unknown > archived);
});

test("normalizeItem rejects unknown types and infers level", () => {
  assert.equal(normalizeItem({ id: "a", name: "a", type: "widget" }), null);
  assert.equal(normalizeItem({ id: "b", name: "b", type: "mcp", requires: ["Stripe API key"] }).level, "intermediate");
});

test("a registry entry that names the registry as its repo doesn't borrow its stars or official owner", () => {
  const item = normalizeItem({ id: "mcp:registry:x/y", type: "mcp", name: "Y", repo: "modelcontextprotocol/registry", stars: 7418, pushedAt: new Date().toISOString() });
  assert.equal(item.repo, null);
  assert.equal(item.official, false);
  assert.equal(item.stars, undefined);
  assert.ok(item.trust.score < 60, `trust ${item.trust.score}`);
});

test("githubRepoFromUrl handles .git, paths and non-GitHub", () => {
  assert.equal(githubRepoFromUrl("https://github.com/acme/tool.git"), "acme/tool");
  assert.equal(githubRepoFromUrl("https://github.com/acme/tool/tree/main/x"), "acme/tool");
  assert.equal(githubRepoFromUrl("https://gitlab.com/acme/tool"), null);
});

test("parseFrontmatter reads quoted and folded values", () => {
  const fm = parseFrontmatter('---\nname: my-skill\ndescription: "Does a thing."\nnote: >\n  folded\n  text\n---\nbody');
  assert.equal(fm.name, "my-skill");
  assert.equal(fm.description, "Does a thing.");
  assert.equal(fm.note, "folded text");
});

test("registryInstall prefers remotes, then npm/pypi/oci packages", () => {
  assert.equal(
    registryInstall({ name: "io.github.acme/weather-mcp", remotes: [{ type: "streamable-http", url: "https://x.dev/mcp" }] }),
    "claude mcp add --transport http weather https://x.dev/mcp",
  );
  assert.equal(registryInstall({ name: "acme/foo", packages: [{ registryType: "npm", identifier: "@acme/foo" }] }), "claude mcp add foo -- npx -y @acme/foo");
  assert.equal(registryInstall({ name: "acme/bar", packages: [{ registryType: "pypi", identifier: "bar-mcp" }] }), "claude mcp add bar -- uvx bar-mcp");
  assert.equal(registryInstall({ name: "acme/none" }), null);
});

test("shortName falls back to the namespace when the last segment is generic", () => {
  assert.equal(shortName("ac.inference.sh/mcp"), "inference");
  assert.equal(shortName("io.github.acme/mcp-server-weather"), "weather");
});

test("parseClaudeMcpAdd reads stdio, remote and header forms", () => {
  assert.deepEqual(parseClaudeMcpAdd("claude mcp add playwright -- npx @playwright/mcp@latest"), {
    transport: "stdio", headers: {}, env: {}, name: "playwright", command: "npx", args: ["@playwright/mcp@latest"],
  });
  const gh = parseClaudeMcpAdd('claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer X"');
  assert.equal(gh.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(gh.headers.Authorization, "Bearer X");
  assert.equal(parseClaudeMcpAdd("/plugin install x@y"), null);
});

test("remote MCP servers work in ChatGPT; local-only ones don't", () => {
  const remote = catalog.byId.get("mcp:notion");
  const local = catalog.byId.get("mcp:playwright");
  assert.ok(remote.agents.includes("chatgpt"));
  assert.ok(!local.agents.includes("chatgpt"));
  for (const agent of ["codex", "gemini", "cursor", "copilot"]) assert.ok(local.agents.includes(agent), agent);
  assert.equal(local.installs.gemini.value, "gemini mcp add playwright npx @playwright/mcp@latest");
  assert.equal(remote.installs.codex.value, "codex mcp add notion --url https://mcp.notion.com/mcp");
});

test("MCP servers install in Windsurf and any other MCP app, but not the Gemini app", () => {
  const remote = catalog.byId.get("mcp:notion");
  const local = catalog.byId.get("mcp:playwright");
  for (const item of [remote, local]) {
    assert.ok(item.agents.includes("windsurf") && item.agents.includes("other"), item.id);
    assert.ok(!item.agents.includes("gemini-app"), item.id);
  }
  assert.deepEqual(JSON.parse(remote.installs.windsurf.value).mcpServers.notion, { serverUrl: "https://mcp.notion.com/mcp" });
  assert.equal(JSON.parse(local.installs.other.value).mcpServers.playwright.command, "npx");
  assert.ok(catalog.byId.get("prompt:bug-hunter").agents.includes("gemini-app"));
});

test("the Gemini app and Windsurf can be named in a query", () => {
  assert.equal(agentInQuery("a prompt for the gemini app").agent, "gemini-app");
  assert.equal(agentInQuery("gemini mcp server for github").agent, "gemini");
  assert.equal(agentInQuery("windsurf browser tools").agent, "windsurf");
});

test("agent filter and agent named in the query both scope results", () => {
  const explicit = search(index, { q: "browser", agent: "chatgpt" }).results;
  assert.ok(explicit.every((r) => r.item.agents.includes("chatgpt")));
  const implied = search(index, { q: "notes for chatgpt" });
  assert.equal(implied.query.impliedAgent, "chatgpt");
  assert.ok(implied.results.some((r) => r.item.id === "mcp:notion"));
  assert.ok(implied.results.every((r) => r.item.agents.includes("chatgpt")));
});

test("a bare 'claude' in a query is not treated as an agent filter", () => {
  assert.equal(agentInQuery("let claude use my browser").agent, null);
  assert.equal(agentInQuery("works in vs code").agent, "copilot");
});

test("prompts work with every agent; Claude Code plugins only with Claude Code", () => {
  assert.equal(catalog.byId.get("prompt:bug-hunter").agents.length, AGENTS.length);
  const plugin = normalizeItem({ id: "plugin:x@y", type: "plugin", name: "x", install: { command: "/plugin install x@y" } });
  assert.deepEqual(plugin.agents, ["claude-code"]);
});

test("agents always match the agents that have install instructions", () => {
  for (const item of catalog.items) {
    if (item.type === "repo") continue;
    assert.deepEqual([...item.agents].sort(), Object.keys(item.installs).sort(), item.id);
  }
  const gem = normalizeItem({ id: "plugin:gemini:a/b", type: "plugin", name: "b", agentInstalls: { gemini: { kind: "command", value: "gemini extensions install https://github.com/a/b" } } });
  assert.deepEqual(gem.agents, ["gemini"]);
  assert.deepEqual(Object.keys(gem.installs), ["gemini"]);
});

test("dedupe keeps the best copy of a republished skill", async () => {
  const { dedupe } = await import("../server/catalog.js");
  const a = normalizeItem({ id: "skill:x:pdf", type: "skill", name: "pdf", summary: "Work with PDFs.", stars: 10 });
  const b = normalizeItem({ id: "skill:y:pdf", type: "skill", name: "pdf", summary: "Work with PDFs.", stars: 900 });
  assert.deepEqual(dedupe([a, b]).map((i) => i.id), ["skill:y:pdf"]);
});

// Regressions found by the simulated users (scripts/simulate.js).

test("misspelled words are corrected to known vocabulary", () => {
  const { query, total } = search(index, { q: "databse" });
  assert.match(query.corrected, /^databases?$/);
  assert.ok(total > 0);
  assert.equal(search(index, { q: "database" }).query.corrected, null);
});

test("rating words don't count as search terms", () => {
  assert.deepEqual(parseQuery("best mcp servers").terms.includes("best"), false);
});

test("untagged repos go to coding agents, not chat apps; prompt collections go everywhere", () => {
  const repo = normalizeItem({ id: "repo:a/tool", type: "repo", name: "tool", repo: "a/tool", tags: [] });
  assert.ok(repo.agents.includes("codex") && !repo.agents.includes("chatgpt") && !repo.agents.includes("gemini-app"));
  const prompts = normalizeItem({ id: "repo:a/p", type: "repo", name: "p", repo: "a/p", tags: ["prompts"] });
  assert.ok(prompts.agents.includes("chatgpt"));
});

test("a vague name is shown as owner/repo", () => {
  assert.equal(normalizeItem({ id: "repo:awslabs/mcp", type: "repo", name: "mcp", repo: "awslabs/mcp" }).name, "awslabs/mcp");
});

test("a repo card is dropped when one plugin installs that same repo", () => {
  const plugin = normalizeItem({ id: "plugin:gemini:o/x", type: "plugin", name: "x", repo: "o/x" });
  const repo = normalizeItem({ id: "repo:o/x", type: "repo", name: "x", repo: "o/x" });
  assert.deepEqual(dedupe([plugin, repo]).map((i) => i.id), ["plugin:gemini:o/x"]);
});

test("mergeSeed lays curated items over an ingested catalog", () => {
  const raw = { items: [{ id: "mcp:a", name: "old" }, { id: "mcp:registry:x", type: "mcp", repo: "Org/Srv" }, { id: "repo:k" }] };
  const seed = { items: [{ id: "mcp:a", name: "new" }, { id: "mcp:b", type: "mcp", repo: "org/srv" }] };
  const merged = mergeSeed(raw, seed).items;
  assert.deepEqual(merged.map((i) => i.id), ["mcp:a", "mcp:b", "repo:k"]);
  assert.equal(merged[0].name, "new");
});

test("chat-app users get prompts for everyday tasks", () => {
  assert.equal(top("help me study for exams", { agent: "gemini-app" }, 1)[0], "prompt:study-tutor");
  assert.equal(top("plan a trip", { agent: "chatgpt" }, 1)[0], "prompt:trip-planner");
});

// From hands-on feedback.

test("a word seen once in the catalog, next to a common spelling, is treated as a typo", () => {
  const summaries = [...Array.from({ length: 25 }, (_, i) => `postgres tool ${i}`), "a postgress helper"];
  const local = buildIndex(summaries.map((summary, i) => normalizeItem({ id: `mcp:t${i}`, type: "mcp", name: `t${i}`, summary })));
  assert.equal(search(local, { q: "postgress" }).query.corrected, "postgres");
});

test("intent tags from deep in a description are dropped; ones the summary implies stay", () => {
  const [esign, browser] = cleanAutoTags([
    { name: "esign-field-placement", summary: "Places signature fields in documents.", tags: ["ecc", "browser", "web", "automation"] },
    { name: "moli", summary: "Headless browser for AI agents.", tags: ["headless-browser", "browser", "web", "automation"] },
  ]);
  assert.deepEqual(esign.tags, ["ecc"]);
  assert.ok(browser.tags.includes("browser"));
});

test("weak one-word matches are cut, but the top results always survive", () => {
  const { results, total } = search(index, { q: "let my ai use a web browser" });
  assert.ok(results.length >= 5 || results.length === total);
  const anchor = results[Math.min(4, results.length - 1)].score;
  assert.ok(results.every((r) => r.score >= anchor * 0.5));
});

test("official-only and easy-setup filters", () => {
  assert.ok(search(index, { q: "database", official: true }).results.every((r) => r.item.official));
  assert.ok(search(index, { q: "database", easy: true }).results.every((r) => r.item.level === "beginner"));
});

test("Claude Desktop config instructions say where the file lives", () => {
  const item = catalog.byId.get("mcp:filesystem");
  assert.match(item.installs.claude.note, /Application Support\/Claude.*APPDATA/);
});

test("a rare real word is not 'corrected' into a shorter stem", () => {
  const summaries = [...Array.from({ length: 25 }, (_, i) => `short clip ${i}`), "make it shorter"];
  const local = buildIndex(summaries.map((summary, i) => normalizeItem({ id: `mcp:s${i}`, type: "mcp", name: `s${i}`, summary })));
  assert.equal(search(local, { q: "shorter" }).query.corrected, null);
});

test("a query that says one of a prompt's use cases finds that prompt", () => {
  assert.equal(top("make it shorter", { agent: "chatgpt" }, 1)[0], "prompt:rewrite-tone");
  assert.equal(top("write sql for me", { agent: "gemini-app" }, 1)[0], "prompt:sql-writer");
});

// GitHub trending (scripts/trending.js).

test("parseTrending reads a github.com/trending row", async () => {
  const { parseTrending } = await import("../scripts/trending.js");
  const html = `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/cloudflare/security-audit-skill" class="Link"><svg></svg>
    <span class="text-normal">cloudflare /</span> security-audit-skill</a></h2>
    <p class="col-9 color-fg-muted my-1 tmp-pr-4">A coding-agent skill for security audits &amp; more</p>
    <span itemprop="programmingLanguage">JavaScript</span>
    <a href="/cloudflare/security-audit-skill/stargazers" class="Link"><svg aria-label="star"><path d="M8"></path></svg>
    52,022</a> <span class="d-inline-block float-sm-right"><svg></svg> 16,002 stars this week </span></article>`;
  assert.deepEqual(parseTrending(html), [
    { repo: "cloudflare/security-audit-skill", description: "A coding-agent skill for security audits & more", language: "JavaScript", stars: 52022, starsGained: 16002 },
  ]);
});

test("trending keeps AI repos with a description and drops jailbreak tools", async () => {
  const { isAiRepo } = await import("../scripts/trending.js");
  assert.equal(isAiRepo({ name: "orca", description: "A place for working with a fleet of agents" }), true);
  assert.equal(isAiRepo({ name: "dotfiles", description: "My zsh config" }), false);
  assert.equal(isAiRepo({ name: "ai-design-skills", description: "" }), false);
  assert.equal(isAiRepo({ name: "x", description: "Jailbreak for every LLM" }), false);
});

test("mergeTrending tags known repos and adds new ones; the trending sort keeps one card per repo", async () => {
  const { mergeTrending, buildCatalog } = await import("../server/catalog.js");
  const { createApi } = await import("../server/api.js");
  const raw = {
    items: [
      { id: "plugin:p@m", type: "plugin", name: "p", repo: "o/p", install: { command: "/plugin install p@m" } },
      { id: "skill:o/p:a", type: "skill", name: "a", repo: "o/p" },
    ],
  };
  const trending = { generatedAt: "2026-10-29T00:00:00Z", repos: [{ repo: "o/p", description: "agents", stars: 10, weekly: 900 }, { repo: "n/new", description: "An LLM tool", stars: 50, weekly: 40, estimated: true }] };
  const catalog = buildCatalog(mergeTrending(raw, trending), "test");
  assert.equal(catalog.byId.get("plugin:p@m").trending.weekly, 900);
  assert.equal(catalog.byId.get("repo:n/new").type, "repo");
  const api = createApi({ state: () => ({ catalog }), rerank: async () => null, aiStatus: () => ({ enabled: false }), saveSubmission: async () => ({}) });
  const [, body] = await api("GET", new URL("http://x/api/items?sort=trending"), async () => "");
  assert.deepEqual(body.items.map((i) => i.id), ["plugin:p@m", "repo:n/new"]);
});
