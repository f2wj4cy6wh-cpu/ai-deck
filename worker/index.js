// Cloudflare Worker. Static assets (the app, plus catalog.json the browser searches) are served by
// Workers Static Assets; this script only handles the server-side API: AI ranking and submissions.
import { buildCatalog } from "../server/catalog.js";
import { buildIndex } from "../server/search.js";
import { createApi } from "../server/api.js";
import { rerank, aiStatus, disableAi, AI_KEY_NAMES } from "../server/ai.js";

const SERVER_ROUTES = new Set(["/api/rank", "/api/ai", "/api/submit"]);

// Only /api/rank needs the catalog (to look up candidates); load it lazily from the assets.
let state = null;
async function ensureState(env, origin) {
  if (state) return;
  const res = await env.ASSETS.fetch(new Request(`${origin}/catalog.json`));
  const catalog = buildCatalog(await res.json(), "catalog.json");
  state = { catalog, index: buildIndex(catalog.items) };
}

function apiFor(env) {
  return createApi({
    state: () => state,
    rerank,
    aiStatus,
    saveSubmission: async (entry) => {
      if (!env.SUBMISSIONS) throw new Error("SUBMISSIONS KV binding is not configured");
      const key = `submission:${entry.url}`;
      if (await env.SUBMISSIONS.get(key)) return { duplicate: true };
      await env.SUBMISSIONS.put(key, JSON.stringify(entry));
      return { duplicate: false };
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!AI_KEY_NAMES.some((name) => env[name])) disableAi(`no AI key secret on this Worker (set one of ${AI_KEY_NAMES.join(", ")})`);
    if (!SERVER_ROUTES.has(url.pathname)) {
      // Search, listings and stats run in the browser; anything else under /api/ doesn't exist here.
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not found" }, { status: 404 });
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/api/rank" && aiStatus().enabled) await ensureState(env, url.origin);
    const [status, body] = await apiFor(env)(request.method, url, () => request.text());
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  },
};
