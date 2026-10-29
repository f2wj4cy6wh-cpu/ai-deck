import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, trustScore, normalizeItem } from "../server/catalog.js";
import { buildIndex, search, parseQuery, tokenize } from "../server/search.js";
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
