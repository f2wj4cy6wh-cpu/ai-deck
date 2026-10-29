import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItem } from "../server/catalog.js";
import worker from "../worker/index.js";

const ORIGIN = "https://ai-deck.example";

// A Worker env with an in-memory KV and limiters that allow `allow` calls before refusing.
function fakeEnv(allow = Infinity) {
  const kv = new Map();
  let calls = 0;
  const limiter = { limit: async () => ({ success: ++calls <= allow }) };
  return {
    kv,
    SUBMISSIONS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    SUBMIT_LIMITER: limiter,
    RANK_LIMITER: limiter,
    ASSETS: { fetch: async () => new Response("asset") },
  };
}

const submit = (body, headers = {}) =>
  new Request(`${ORIGIN}/api/submit`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body });
const link = JSON.stringify({ url: "https://github.com/org/repo", category: "mcp" });

test("item links that aren't http(s) are dropped, so they can't run script from an href", () => {
  for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
    assert.equal(normalizeItem({ id: "mcp:x", type: "mcp", name: "x", url }).url, null, url);
  }
  assert.equal(normalizeItem({ id: "mcp:x", type: "mcp", name: "x", homepage: "https://x.dev" }).url, "https://x.dev");
});

test("a same-origin JSON submission is stored", async () => {
  const env = fakeEnv();
  const res = await worker.fetch(submit(link), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(env.kv.size, 1);
});

test("submissions from another site, as a form post, or oversized are refused before KV", async () => {
  const env = fakeEnv();
  assert.equal((await worker.fetch(submit(link, { origin: "https://evil.example" }), env)).status, 403);
  assert.equal((await worker.fetch(submit(link, { "content-type": "text/plain" }), env)).status, 415);
  assert.equal((await worker.fetch(submit(JSON.stringify({ url: "https://x.dev/a", note: "n".repeat(10_000) })), env)).status, 413);
  assert.equal(env.kv.size, 0);
});

test("submissions are rate limited per IP", async () => {
  const env = fakeEnv(2);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await worker.fetch(submit(JSON.stringify({ url: `https://github.com/o/r${i}` })), env)).status);
  assert.deepEqual(statuses, [200, 200, 429]);
});

test("the AI status doesn't list which secret names the Worker looks for", async () => {
  const body = await (await worker.fetch(new Request(`${ORIGIN}/api/ai`), fakeEnv())).json();
  assert.equal(body.enabled, false);
  assert.doesNotMatch(body.reason, /API_KEY/);
});
