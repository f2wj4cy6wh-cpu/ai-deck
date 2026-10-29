// Runtime-neutral helpers for the video finder (/api/video): checking what the visitor gave us, and
// matching the tools a model spotted in a video against the catalog. Shared by the Worker and the browser
// (copied to public/lib by scripts/build-web.js); the model call itself is in video-ai.js.
import { search, editDistance } from "./search.js";

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * What the visitor pasted: a public YouTube video, a link the server can't fetch (Instagram, TikTok…:
 * they need the file instead), or nothing usable. Returns { youtube } | { error }.
 */
export function parseVideoInput(text) {
  let url;
  try {
    url = new URL(String(text ?? "").trim());
  } catch {
    return { error: "Paste a YouTube link, or upload the video file." };
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  if (/(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|threads\.net)$/.test(host)) {
    return { error: "That site keeps videos behind a login, so AI Deck can't open the link. Save the video to your device and upload the file instead." };
  }
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1);
  else if (host === "youtube.com") id = url.searchParams.get("v") ?? url.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/)?.[2];
  if (!id || !/^[\w-]{11}$/.test(id)) return { error: "Only YouTube links can be read directly. For anything else, upload the video file." };
  return { youtube: `https://www.youtube.com/watch?v=${id}` };
}

const compact = (s) => String(s ?? "").toLowerCase().replace(/\b(mcp|server|plugin|skill|for|the|ai)\b/g, "").replace(/[^a-z0-9]/g, "");
const TYPE_ORDER = { repo: 0, plugin: 1, mcp: 2, skill: 3, prompt: 4 };

/** owner/repo from a GitHub link or a bare "owner/repo". */
export function repoFromText(text) {
  const m = String(text ?? "").match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i);
  return m && !/^(www|https?:)$/i.test(m[1]) ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The npm package an install command runs (`npx -y @playwright/mcp@latest` -> "@playwright/mcp"). */
export function packageFromCommand(command) {
  const m = String(command ?? "").match(/\b(?:npx|bunx|pnpm dlx|uvx)\s+(?:-y\s+|--yes\s+)?((?:@[\w.-]+\/)?[\w.-]+)/);
  return m ? m[1].replace(/@[\w.^~-]*$/, "").toLowerCase() : null;
}

/**
 * Matches mentions ({ name, repo?, url?, command? }) to catalog items. Strongest evidence first: a GitHub repo
 * shown on screen, then the package an install command runs, then the name, which must closely match the
 * item's name or repo (search alone would happily return *something* for any name).
 * Returns [{ mention, item, via: "repo" | "package" | "name" | null }], one per mention, best card per tool.
 */
export function matchMentions(index, catalog, mentions) {
  const byRepo = new Map();
  for (const item of catalog.items) {
    if (!item.repo) continue;
    const key = item.repo.toLowerCase();
    const current = byRepo.get(key);
    if (!current || TYPE_ORDER[item.type] < TYPE_ORDER[current.type]) byRepo.set(key, item);
  }
  let byPackage = null; // built on first need: most mentions resolve by repo or name

  return mentions.map((mention) => {
    const repo = repoFromText(mention.repo) ?? repoFromText(mention.url);
    if (repo && byRepo.has(repo)) return { mention, item: byRepo.get(repo), via: "repo" };

    const pkg = packageFromCommand(mention.command);
    if (pkg) {
      byPackage ??= new Map(catalog.items.map((i) => [packageFromCommand(i.install?.command), i]).filter(([p]) => p));
      if (byPackage.has(pkg)) return { mention, item: byPackage.get(pkg), via: "package" };
    }

    const want = compact(mention.name);
    if (want.length >= 3) {
      const { results } = search(index, { q: mention.name, limit: 5, level: "expert" });
      const hit = results.find(({ item }) => {
        const names = [item.name, item.repo?.split("/")[1]].map(compact).filter(Boolean);
        return names.some((n) => n === want || editDistance(n, want, Math.max(1, Math.floor(want.length / 6))) <= Math.max(1, Math.floor(want.length / 6)));
      });
      if (hit) return { mention, item: hit.item, via: "name" };
    }
    return { mention, item: null, via: null };
  });
}
