#!/usr/bin/env node
// Prepares public/ for serving: copies the runtime-neutral modules the browser runs search with,
// and a compact catalog.json. Search runs client-side so hosting stays static-file cheap.
import fs from "node:fs";
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
// Drop fields the browser never reads to keep the download small.
const items = raw.items.map(({ source, homepage, ...item }) => (source === "seed" ? { ...item, curated: true } : item));
const out = JSON.stringify({ generatedAt: raw.generatedAt ?? null, trendingAt: raw.trendingAt ?? null, items });
fs.writeFileSync(path.join(root, "public", "catalog.json"), out);

console.log(`[build-web] lib: ${SHARED.join(", ")}; catalog.json from ${catalogFile}: ${items.length} items, ${(out.length / 1e6).toFixed(1)} MB`);
