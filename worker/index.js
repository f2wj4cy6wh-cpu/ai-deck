// Cloudflare Worker. Static assets (the app, plus catalog.json the browser searches) are served by
// Workers Static Assets; this script only handles the server-side API: AI ranking and submissions.
import { buildCatalog } from "../server/catalog.js";
import { buildIndex } from "../server/search.js";
import { createApi } from "../server/api.js";
import { rerank, aiStatus, disableAi, AI_KEY_NAMES } from "../server/ai.js";
import { parseVideoInput, MAX_VIDEO_BYTES } from "../server/video.js";
import { findToolsInVideo } from "../server/video-ai.js";

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

const MAX_BODY = 4096; // a submission is a link and a 500-character note

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * Checks a request to a route that writes to KV or spends AI credits: per-IP rate limit, and for
 * POSTs a same-origin JSON body of bounded size. Requiring application/json makes a cross-site
 * browser POST need a CORS preflight, which this Worker never grants. Returns an error response or null.
 */
async function guard(request, env, url) {
  const limiter = url.pathname === "/api/submit" ? env.SUBMIT_LIMITER : url.pathname === "/api/rank" ? env.RANK_LIMITER : null;
  if (limiter) {
    const { success } = await limiter.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return json({ error: "Too many requests. Try again in a minute." }, 429);
  }
  if (request.method !== "POST") return null;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed" }, 403);
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return json({ error: "Expected a JSON body" }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "Request too large" }, 413);
  return null;
}

const geminiKey = (env) => env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;
const VIDEO_DAILY_LIMIT = 200;

/** Site-wide videos-per-day budget (on top of the per-IP limiter): a KV counter per UTC day. */
async function takeDailyVideo(env) {
  if (!env.SUBMISSIONS) return true;
  const key = `video-count:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.SUBMISSIONS.get(key)) || 0;
  if (used >= (Number(env.VIDEO_DAILY_LIMIT) || VIDEO_DAILY_LIMIT)) return false;
  await env.SUBMISSIONS.put(key, String(used + 1), { expirationTtl: 2 * 86_400 });
  return true;
}

/**
 * /api/video: GET says whether the finder is on; POST takes {"youtube": url} as JSON, or the video file
 * itself as a video/* body, and returns the tools Gemini spotted. Matching them to the catalog happens in
 * the browser, which already has the catalog and index loaded.
 */
async function handleVideo(request, env, url) {
  const key = geminiKey(env);
  if (request.method === "GET") {
    return json(key ? { enabled: true, maxBytes: MAX_VIDEO_BYTES } : { enabled: false, reason: "The video finder is not configured on this deployment" });
  }
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed" }, 403);
  if (!key) return json({ error: "The video finder is not configured on this deployment" }, 503);

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const size = Number(request.headers.get("content-length"));
  let input;
  if (type === "application/json") {
    if (!(size > 0 && size <= MAX_BODY)) return json({ error: "Request too large" }, 413);
    let payload;
    try {
      payload = JSON.parse(await readLimited(request));
    } catch {
      return json({ error: "Expected a JSON body" }, 400);
    }
    input = parseVideoInput(payload.youtube);
    if (input.error) return json({ error: input.error }, 400);
  } else if (/^video\/[\w.+-]+$/.test(type)) {
    if (!(size > 0)) return json({ error: "Upload the video as a file (its size must be known)" }, 411);
    if (size > MAX_VIDEO_BYTES) return json({ error: `That video is over ${MAX_VIDEO_BYTES / 1024 / 1024} MB. Trim it, or upload a shorter clip.` }, 413);
    // FixedLengthStream makes the runtime enforce the declared size while streaming, with no JS per chunk.
    let body = request.body;
    if (typeof FixedLengthStream === "function") {
      const fixed = new FixedLengthStream(size);
      request.body.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    }
    input = { body, size, mimeType: type };
  } else {
    // Also forces a CORS preflight for cross-site browser posts, which this Worker never grants.
    return json({ error: "Send a YouTube link as JSON, or the video file" }, 415);
  }

  const { success } = (await env.VIDEO_LIMITER?.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })) ?? { success: true };
  if (!success) return json({ error: "Too many videos. Try again in a minute." }, 429);
  if (!(await takeDailyVideo(env))) return json({ error: "AI Deck has reached today's video limit. Try again tomorrow." }, 429);

  try {
    const found = await findToolsInVideo({ apiKey: key, ...input, model: env.AI_DECK_VIDEO_MODEL || undefined });
    return json(found);
  } catch (error) {
    console.error("[video]", error);
    if (input.youtube && error.status >= 400 && error.status < 500) {
      return json({ error: "Gemini couldn't open that YouTube video. It has to be public; or download it and upload the file." }, 422);
    }
    return json({ error: "Couldn't analyze that video. Try again, or try a shorter clip." }, 502);
  }
}

// Reads at most MAX_BODY bytes even when content-length is missing or wrong (chunked uploads).
async function readLimited(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/**
 * catalog.json is the one big download. scripts/build-web.js writes a max-level brotli copy next to it;
 * hand that over as-is (encodeBody: "manual") instead of letting the edge recompress at a lower level.
 * The copy's own ETag drives revalidation, so a repeat visit still gets a 304.
 */
async function serveCatalog(request, env, url) {
  if (!/\bbr\b/.test(request.headers.get("accept-encoding") ?? "")) return env.ASSETS.fetch(request);
  const res = await env.ASSETS.fetch(new Request(`${url.origin}/catalog.json.br`, request));
  if (res.status !== 200 && res.status !== 304) return env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.set("content-encoding", "br");
  headers.set("vary", "accept-encoding");
  headers.set("x-content-type-options", "nosniff");
  headers.delete("content-length");
  return new Response(res.status === 304 ? null : res.body, { status: res.status, headers, encodeBody: "manual" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/catalog.json") return serveCatalog(request, env, url);
    if (url.pathname === "/api/video") return handleVideo(request, env, url);
    // A key alone doesn't turn on search ranking (a model call per search): GEMINI_API_KEY is also what
    // the video finder uses. Ranking needs the AI_DECK_RANKING=on var as well.
    if (env.AI_DECK_RANKING !== "on" || !AI_KEY_NAMES.some((name) => env[name])) disableAi(`AI ranking is not configured on this deployment`);
    if (!SERVER_ROUTES.has(url.pathname)) {
      // Search, listings and stats run in the browser; anything else under /api/ doesn't exist here.
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    }
    const blocked = await guard(request, env, url);
    if (blocked) return blocked;
    let text = "";
    if (request.method === "POST") {
      try {
        text = await readLimited(request);
      } catch {
        return json({ error: "Request too large" }, 413);
      }
    }
    if (url.pathname === "/api/rank" && aiStatus().enabled) await ensureState(env, url.origin);
    const [status, body] = await apiFor(env)(request.method, url, async () => text);
    return json(body, status);
  },
};
