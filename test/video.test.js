import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../server/load.js";
import { buildIndex } from "../server/search.js";
import { matchMentions, parseVideoInput, packageFromCommand, repoFromText } from "../server/video.js";
import { findToolsInVideo, cleanTools } from "../server/video-ai.js";
import worker from "../worker/index.js";

const catalog = loadCatalog(undefined, { seedOnly: true });
const index = buildIndex(catalog.items);
const ORIGIN = "https://ai-deck.example";

const answer = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], modelVersion: "gemini-test" });

/** A fake Gemini: records calls, answers the generate step. */
function fakeGemini(result = { summary: "s", tools: [{ name: "Playwright MCP", kind: "mcp", confidence: "shown" }] }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", init });
    if (String(url).includes(":generateContent")) return Response.json(answer(result));
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl };
}

test("parseVideoInput accepts YouTube links and turns away login-walled sites", () => {
  assert.deepEqual(parseVideoInput("https://youtu.be/dQw4w9WgXcQ"), { youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.deepEqual(parseVideoInput("https://m.youtube.com/shorts/dQw4w9WgXcQ?si=x"), { youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.match(parseVideoInput("https://www.instagram.com/reel/C123/").error, /behind a login/);
  assert.match(parseVideoInput("https://vimeo.com/1").error, /Only YouTube/);
  assert.ok(parseVideoInput("not a link").error);
});

test("repo and package are read from links and install commands", () => {
  assert.equal(repoFromText("https://github.com/Microsoft/playwright-mcp/tree/main"), "microsoft/playwright-mcp");
  assert.equal(repoFromText("upstash/context7"), "upstash/context7");
  assert.equal(packageFromCommand("claude mcp add pw -- npx -y @playwright/mcp@latest"), "@playwright/mcp");
  assert.equal(packageFromCommand("pip install x"), null);
});

test("mentions match by repo, then install command, then a close name; strangers stay unmatched", () => {
  const out = matchMentions(index, catalog, [
    { name: "browser thing", url: "https://github.com/microsoft/playwright-mcp" },
    { name: "x", command: "npx @playwright/mcp@latest" },
    { name: "Playwright MCP" },
    { name: "Frobnicator Pro Max" },
  ]);
  assert.deepEqual(out.map((m) => [m.via, m.item?.id ?? null]), [
    ["repo", "mcp:playwright"],
    ["package", "mcp:playwright"],
    ["name", "mcp:playwright"],
    [null, null],
  ]);
});

test("model output is cleaned: bad links dropped, strings capped, unknown confidence becomes a guess", () => {
  const { tools } = cleanTools({ summary: "s", tools: [{ name: "  A  ", kind: "mcp", url: "javascript:alert(1)", confidence: "sure", what: "w".repeat(500) }, { kind: "mcp" }] });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "A");
  assert.equal(tools[0].url, undefined);
  assert.equal(tools[0].confidence, "guess");
  assert.equal(tools[0].what.length, 160);
});

test("a YouTube link goes straight to the model in one call", async () => {
  const { calls, fetchImpl } = fakeGemini();
  const found = await findToolsInVideo({ apiKey: "k", youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", fetchImpl });
  assert.equal(found.tools[0].name, "Playwright MCP");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-2\.5-flash:generateContent$/);
  assert.match(calls[0].init.body, /youtube\.com\/watch\?v=dQw4w9WgXcQ/);
});

// ---- the Worker route ----

function fakeEnv({ key = "test-key", allow = Infinity } = {}) {
  const kv = new Map();
  let calls = 0;
  return {
    kv,
    GEMINI_API_KEY: key,
    SUBMISSIONS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    VIDEO_LIMITER: { limit: async () => ({ success: ++calls <= allow }) },
    ASSETS: { fetch: async () => new Response("asset") },
  };
}
const postJson = (body, headers = {}) =>
  new Request(`${ORIGIN}/api/video`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(JSON.stringify(body).length), origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
const youtube = { youtube: "https://youtu.be/dQw4w9WgXcQ" };

async function withFakeFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fakeGemini().fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("GET /api/video says whether the finder is on", async () => {
  assert.equal((await (await worker.fetch(new Request(`${ORIGIN}/api/video`), fakeEnv())).json()).enabled, true);
  assert.equal((await (await worker.fetch(new Request(`${ORIGIN}/api/video`), fakeEnv({ key: "" }))).json()).enabled, false);
});

test("a YouTube link returns the tools, and counts toward the daily cap", async () => {
  const env = fakeEnv();
  const res = await withFakeFetch(() => worker.fetch(postJson(youtube), env));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).tools[0].name, "Playwright MCP");
  assert.equal([...env.kv.values()][0], "1");
});

test("the video route refuses bad input before spending anything", async () => {
  const cases = [
    [postJson(youtube, { origin: "https://evil.example" }), fakeEnv(), 403],
    [postJson(youtube), fakeEnv({ key: "" }), 503],
    [postJson({ youtube: "https://www.instagram.com/reel/x/" }), fakeEnv(), 400],
    [new Request(`${ORIGIN}/api/video`, { method: "POST", headers: { "content-type": "video/mp4", "content-length": "1", origin: ORIGIN }, body: "x" }), fakeEnv(), 415],
    [new Request(`${ORIGIN}/api/video`, { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body: "{}" }), fakeEnv(), 415],
  ];
  for (const [req, env, status] of cases) {
    assert.equal((await withFakeFetch(() => worker.fetch(req, env))).status, status);
    assert.equal(env.kv.size, 0, "nothing counted");
  }
});

test("videos are rate limited per IP and capped per day", async () => {
  const limited = fakeEnv({ allow: 1 });
  const statuses = [];
  for (let i = 0; i < 2; i++) statuses.push((await withFakeFetch(() => worker.fetch(postJson(youtube), limited))).status);
  assert.deepEqual(statuses, [200, 429]);

  const capped = fakeEnv();
  capped.VIDEO_DAILY_LIMIT = "1";
  await withFakeFetch(() => worker.fetch(postJson(youtube), capped));
  const res = await withFakeFetch(() => worker.fetch(postJson(youtube), capped));
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /today/);
});
