// Local Node server: serves public/ and the API. The hosted version runs worker/index.js instead.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, DATA_DIR } from "./load.js";
import { buildIndex } from "./search.js";
import { createApi } from "./api.js";
import { rerank, aiStatus } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "..", "public");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "submissions.json");
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";

let catalog = loadCatalog();
let index = buildIndex(catalog.items);

// Pick up a fresh `npm run ingest` without restarting.
let reloadTimer;
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

const handleApi = createApi({
  state: () => ({ catalog, index }),
  rerank,
  aiStatus,
  saveSubmission: async (entry) => {
    const existing = fs.existsSync(SUBMISSIONS_FILE) ? JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf8")) : [];
    if (existing.some((s) => s.url === entry.url)) return { duplicate: true };
    existing.push(entry);
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(existing, null, 2));
    return { duplicate: false };
  },
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url);
  const [status, body] = await handleApi(req.method, url, () => readBody(req));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
});

server.listen(PORT, HOST, () => {
  const ai = aiStatus();
  console.log(`AI_DECK running at http://${HOST}:${PORT}`);
  console.log(`[catalog] ${catalog.items.length} items from ${catalog.source}`);
  console.log(ai.enabled ? `[ai] AI ranking on: ${ai.provider} (${ai.model})` : `[ai] AI ranking off: ${ai.reason}`);
});
