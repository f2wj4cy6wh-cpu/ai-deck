// Node-only: reads the catalog from disk. The Worker imports catalog.json directly instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, mergeSeed } from "./catalog.js";
import { cleanAutoTags } from "./search.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, "..", "data");

/** Loads data/catalog.json (written by `npm run ingest`), falling back to the seed. */
export function loadCatalog(dataDir = DATA_DIR, { seedOnly = false } = {}) {
  const catalogFile = path.join(dataDir, "catalog.json");
  const seedFile = path.join(dataDir, "seed.json");
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  if (seedOnly || !fs.existsSync(catalogFile)) return buildCatalog(seed, "seed.json");
  const raw = mergeSeed(JSON.parse(fs.readFileSync(catalogFile, "utf8")), seed);
  cleanAutoTags(raw.items);
  return buildCatalog(raw, "catalog.json");
}
