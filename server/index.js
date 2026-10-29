import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, catalogStats, TYPES, DATA_DIR } from "./catalog.js";
import { buildIndex, search, topTags } from "./search.js";
import { rerank, aiStatus } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "..", "public");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "submissions.json");
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";

let catalog = loadCatalog();
let index = buildIndex(catalog.items);

// Pick up a fresh `npm run ingest` without restarting.
fs.watch(DATA_DIR, (_event, file) => {
  if (file !== "catalog.json") return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      catalog = loadCatalog();
      index = buildIndex(catalog.items);
      console.log(`[catalog] reloaded ${catalog.items.length} items`);
    } catch (error) {
      console.warn(`[catalog] reload failed, keeping previous catalog: ${error.message}`);
    }
  }, 300);
});
let reloadTimer;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function publicItem(item) {
  // Strip nothing sensitive today, but keep a single choke point for what leaves the server.
  return item;
}

function parseLevel(value) {
  return value === "expert" ? "expert" : "beginner";
}

function parseType(value) {
  return TYPES.includes(value) ? value : null;
}

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const routes = {
  "GET /api/stats": () => ({ ...catalogStats(catalog), ai: aiStatus() }),

  "GET /api/search": (url) => {
    const q = (url.searchParams.get("q") ?? "").slice(0, 300);
    const tags = url.searchParams.getAll("tag").filter(Boolean);
    const limit = Math.min(60, Number(url.searchParams.get("limit")) || 30);
    const { results, total, query } = search(index, {
      q,
      type: parseType(url.searchParams.get("type")),
      level: parseLevel(url.searchParams.get("level")),
      tags,
      limit,
    });
    return {
      total,
      intent: { tags: query.tags, impliedType: query.impliedType },
      results: results.map((r) => ({ item: publicItem(r.item), why: r.why, score: Number(r.score.toFixed(3)) })),
    };
  },

  // Second phase of a search: the client calls this after rendering local results.
  "GET /api/rank": async (url) => {
    const q = (url.searchParams.get("q") ?? "").slice(0, 300);
    const level = parseLevel(url.searchParams.get("level"));
    const { results } = search(index, { q, type: parseType(url.searchParams.get("type")), level, limit: 20 });
    const ranked = await rerank(q, level, results.map((r) => r.item));
    if (!ranked) return { ai: false, ...aiStatus() };
    return {
      ai: true,
      model: ranked.model,
      clarify: ranked.clarify,
      results: ranked.picks.map((p) => ({ item: publicItem(catalog.byId.get(p.id)), why: p.why })),
    };
  },

  "GET /api/items": (url) => {
    const type = parseType(url.searchParams.get("type"));
    const types = url.searchParams.getAll("types").filter((t) => TYPES.includes(t));
    const tag = url.searchParams.get("tag");
    const language = url.searchParams.get("language");
    const category = url.searchParams.get("category");
    const ids = url.searchParams.get("ids");
    const sort = url.searchParams.get("sort") ?? "trust";
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(100, Number(url.searchParams.get("limit")) || 40);

    let items = catalog.items;
    if (ids) {
      const wanted = ids.split(",").slice(0, 200);
      items = wanted.map((id) => catalog.byId.get(id)).filter(Boolean);
    }
    if (type) items = items.filter((i) => i.type === type);
    if (types.length) items = items.filter((i) => types.includes(i.type));
    if (tag) items = items.filter((i) => i.tags.includes(tag.toLowerCase()));
    if (language) items = items.filter((i) => i.language === language);
    if (category) items = items.filter((i) => i.category === category);

    const sorters = {
      trust: (a, b) => b.trust.score - a.trust.score || (b.stars ?? 0) - (a.stars ?? 0),
      stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
      updated: (a, b) => Date.parse(b.pushedAt ?? 0) - Date.parse(a.pushedAt ?? 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    if (!ids) items = [...items].sort(sorters[sort] ?? sorters.trust);

    const pool = type || types.length ? items : catalog.items;
    return {
      total: items.length,
      items: items.slice(offset, offset + limit).map(publicItem),
      tags: topTags(pool, 14),
      languages: [...new Set(pool.map((i) => i.language).filter(Boolean))].sort(),
    };
  },

  "POST /api/submit": async (_url, req) => {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return [400, { error: "Expected a JSON body" }];
    }
    const link = String(payload.url ?? "").trim();
    if (!/^https:\/\/[\w.-]+\/\S+$/.test(link) || link.length > 400) {
      return [400, { error: "Enter an https:// link to a repo or manifest" }];
    }
    const category = TYPES.includes(payload.category) ? payload.category : "skill";
    const existing = fs.existsSync(SUBMISSIONS_FILE) ? JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf8")) : [];
    if (existing.some((s) => s.url === link)) return { ok: true, duplicate: true };
    existing.push({ url: link, category, note: String(payload.note ?? "").slice(0, 500), submittedAt: new Date().toISOString() });
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(existing, null, 2));
    return { ok: true };
  },
};

async function handleApi(req, res, url) {
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return sendJson(res, 404, { error: "Not found" });
  try {
    const result = await route(url, req);
    if (Array.isArray(result)) return sendJson(res, result[0], result[1]);
    return sendJson(res, 200, result);
  } catch (error) {
    console.error(`[api] ${req.method} ${url.pathname} failed:`, error);
    return sendJson(res, 500, { error: "Internal error" });
  }
}

function serveStatic(res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.resolve(PUBLIC_DIR, "." + requested);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      // SPA fallback: unknown paths get the app shell.
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, html) => {
        if (fallbackError) return res.writeHead(404).end("Not found");
        res.writeHead(200, { "content-type": MIME[".html"] }).end(html);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(res, url);
});

server.listen(PORT, HOST, () => {
  const ai = aiStatus();
  console.log(`AI_DECK running at http://${HOST}:${PORT}`);
  console.log(`[catalog] ${catalog.items.length} items from ${catalog.source}`);
  console.log(ai.enabled ? `[ai] Claude ranking on (${ai.model})` : `[ai] Claude ranking off: ${ai.reason}`);
});
