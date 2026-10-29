#!/usr/bin/env node
// Prepares public/ for serving: copies the runtime-neutral modules the browser runs search with,
// and a compact catalog.json. Search runs client-side so hosting stays static-file cheap.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeSeed, mergeTrending } from "../server/catalog.js";
import { cleanAutoTags } from "../server/search.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = ["agents.js", "catalog.js", "search.js", "api.js"];
const libDir = path.join(root, "public", "lib");

fs.mkdirSync(libDir, { recursive: true });
for (const file of SHARED) fs.copyFileSync(path.join(root, "server", file), path.join(libDir, file));

const catalogFile = fs.existsSync(path.join(root, "data", "catalog.json")) ? "catalog.json" : "seed.json";
const readData = (file) => JSON.parse(fs.readFileSync(path.join(root, "data", file), "utf8"));
const merged = catalogFile === "seed.json" ? readData("seed.json") : mergeSeed(readData("catalog.json"), readData("seed.json"));
const hasTrending = fs.existsSync(path.join(root, "data", "trending.json"));
const raw = hasTrending ? mergeTrending(merged, readData("trending.json")) : merged;
cleanAutoTags(raw.items);
// Drop fields the browser never reads to keep the download small. Two thirds of the descriptions just
// repeat the summary; normalizeItem() fills a missing description back in from the summary.
const items = raw.items.map(({ source, homepage, registryName, ...item }) => {
  if (item.description === item.summary) delete item.description;
  return source === "seed" ? { ...item, curated: true } : item;
});
const out = JSON.stringify({ generatedAt: raw.generatedAt ?? null, trendingAt: raw.trendingAt ?? null, items });
fs.writeFileSync(path.join(root, "public", "catalog.json"), out);
// Cloudflare compresses on the fly at a low brotli level; the Worker serves this max-level copy instead (~25% smaller).
const br = zlib.brotliCompressSync(out, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: out.length } });
fs.writeFileSync(path.join(root, "public", "catalog.json.br"), br);

console.log(`[build-web] lib: ${SHARED.join(", ")}; catalog.json from ${catalogFile}: ${items.length} items, ${(out.length / 1e6).toFixed(1)} MB (${(br.length / 1e6).toFixed(2)} MB brotli)`);
