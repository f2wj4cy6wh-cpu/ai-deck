#!/usr/bin/env node
// Writes data/trending.json: AI repos that are gaining stars right now.
//   1. github.com/trending (daily, weekly, monthly, and the main AI languages): GitHub has no API for it,
//      so the public page is read once per run, a dozen requests. robots.txt does not disallow /trending.
//   2. GitHub search: AI repos created in the last 30 days, by stars ("new and rising"), so a change to
//      the trending page's markup doesn't leave the section empty.
// The build (scripts/build-web.js, server/load.js) merges it into the catalog, like the seed.
//
// Usage: node scripts/trending.js        (GITHUB_TOKEN or a signed-in gh CLI raises search limits)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const PERIODS = ["daily", "weekly", "monthly"];
const LANGUAGES = ["", "python", "typescript", "javascript", "rust", "go", "jupyter-notebook"];
const UA = { "user-agent": "ai-deck-ingest (+https://github.com/trending reader, once per run)" };

// Name or description has to read as AI tooling; trending also lists games, dotfiles and so on.
const AI_WORDS =
  /\b(ai|llms?|gpt|chatgpt|agents?|agentic|mcp|claude|codex|gemini|copilot|cursor|openai|anthropic|rag|prompts?|inference|diffusion|transformers?|embeddings?|chatbots?|machine learning|deep learning|neural|vibe.?coding|skills?|ollama|langchain|fine.?tun\w*|multimodal|speech.to.text|text.to.speech|voice agent)\b/i;

// Model-safety bypasses aren't tools we want to promote, however many stars they get.
const EXCLUDE = /jailbreak|破甲|越狱|uncensor|bypass (the )?(safety|guardrails|filters?)/i;

export function isAiRepo({ name, description }) {
  const text = `${name.replace(/[-_.]/g, " ")} ${description ?? ""}`;
  // No description means nothing to show on a card or match a search against.
  return Boolean(description?.trim()) && AI_WORDS.test(text) && !EXCLUDE.test(text);
}

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const count = (s) => Number(String(s ?? "").replace(/[^0-9]/g, "")) || 0;

/** Parses github.com/trending HTML into [{ repo, description, language, stars, starsGained }]. */
export function parseTrending(html) {
  const rows = [];
  for (const [, row] of html.matchAll(/<article class="Box-row">([\s\S]*?)<\/article>/g)) {
    const repo = row.match(/<h2[^>]*>[\s\S]*?href="\/([^"/]+\/[^"/]+)"/)?.[1];
    if (!repo) continue;
    rows.push({
      repo,
      description: decode(row.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? ""),
      language: row.match(/itemprop="programmingLanguage">([^<]+)</)?.[1]?.trim() ?? null,
      stars: count(row.match(/\/stargazers"[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)/)?.[1]),
      starsGained: count(row.match(/([\d,]+)\s+stars? (today|this week|this month)/)?.[1]),
    });
  }
  return rows;
}

/** Stars gained in a week: the exact weekly figure when GitHub listed one, else scaled from another period. */
export function weeklyStars(periods) {
  if (periods.weekly != null) return periods.weekly;
  if (periods.daily != null) return periods.daily * 7;
  if (periods.monthly != null) return Math.round(periods.monthly / 4);
  return periods.new ?? 0;
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  for (const bin of ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]) {
    try {
      return execFileSync(bin, ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      // not installed or not signed in
    }
  }
  return null;
}

/** New AI repos (last 30 days) with the most stars: a fallback signal that needs no HTML parsing. */
async function risingFromSearch(token) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const headers = { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const out = [];
  for (const topic of ["llm", "ai-agents", "mcp", "claude-code", "agent-skills", "generative-ai"]) {
    const q = encodeURIComponent(`topic:${topic} created:>=${since} stars:>=50 archived:false`);
    try {
      const res = JSON.parse(await fetchText(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=30`, headers));
      for (const r of res.items ?? []) {
        const days = Math.max(1, (Date.now() - Date.parse(r.created_at)) / 86_400_000);
        out.push({ repo: r.full_name, description: r.description ?? "", language: r.language, stars: r.stargazers_count, starsGained: Math.round((r.stargazers_count / days) * 7), createdAt: r.created_at, estimated: true });
      }
    } catch (error) {
      console.warn(`[trending] search ${topic}: ${error.message}`);
    }
  }
  return out;
}

async function main() {
  const found = new Map(); // repo lowercased -> entry
  const keep = (row, period) => {
    if (!isAiRepo({ name: row.repo.split("/")[1], description: row.description })) return;
    const key = row.repo.toLowerCase();
    const entry = found.get(key) ?? { ...row, periods: {} };
    // Stars gained per period, from the page (exact) or estimated from age (search).
    entry.periods[period] = Math.max(entry.periods[period] ?? 0, row.starsGained);
    entry.stars = Math.max(entry.stars ?? 0, row.stars);
    if (!entry.estimated || !row.estimated) entry.estimated = Boolean(entry.estimated && row.estimated);
    found.set(key, entry);
  };

  let pages = 0;
  for (const language of LANGUAGES) {
    for (const period of PERIODS) {
      const url = `https://github.com/trending${language ? `/${language}` : ""}?since=${period}`;
      try {
        const rows = parseTrending(await fetchText(url));
        pages++;
        rows.forEach((row) => keep(row, period));
      } catch (error) {
        console.warn(`[trending] ${url}: ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, 400)); // be gentle
    }
  }
  const rising = await risingFromSearch(githubToken());
  rising.forEach((row) => keep(row, "new"));

  const repos = [...found.values()].map((r) => ({ ...r, weekly: weeklyStars(r.periods) })).sort((a, b) => b.weekly - a.weekly);
  const out = { generatedAt: new Date().toISOString(), pages, repos };
  fs.writeFileSync(path.join(DATA_DIR, "trending.json"), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`[trending] ${pages} trending pages + search: ${repos.length} AI repos -> data/trending.json`);
  for (const r of repos.slice(0, 10)) console.log(`  +${r.weekly}/wk ${r.repo}`);
}

if (process.argv[1]?.endsWith("trending.js")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
