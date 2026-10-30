// AI Deck front end. Vanilla ES module, hash routing. Screens follow the taste-skill app sheet
// "data-terminal" with the brand's colours and faces kept (styles.css).
//
// Search and listings run in the browser over /catalog.json using the same modules as the server
// (copied to /lib by scripts/build-web.js). Only AI ranking and submissions go to the server.
import { buildCatalog } from "./lib/catalog.js";
import { buildIndex } from "./lib/search.js";
import { createApi } from "./lib/api.js";
import { connectorUrl } from "./lib/agents.js";

const $view = document.getElementById("view");
const $toast = document.getElementById("toast");
const $modalRoot = document.getElementById("modal-root");
const $sectionLabel = document.getElementById("section-label");

// ---------- persistent per-viewer state ----------

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage disabled: state just won't survive a reload.
  }
}

const $agentSelect = document.getElementById("agent-select");

// First visit from a chat app's link: start with that app picked. A choice in the menu always wins.
function agentFromReferrer() {
  let host = "";
  try {
    host = new URL(document.referrer).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(host)) return "chatgpt";
  if (/(^|\.)claude\.ai$/.test(host)) return "claude";
  if (/^gemini\.google\.com$/.test(host)) return "gemini-app";
  return null;
}

const state = {
  level: readStore("aideck.level", "beginner"),
  agent: readStore("aideck.agent", null) ?? agentFromReferrer() ?? "all",
  agents: [], // [{id, label, short}] from /api/stats
  installTab: new Map(), // item id -> agent tab picked on that card
  saved: new Set(readStore("aideck.saved", [])),
  recent: readStore("aideck.recent", []),
  items: new Map(), // id -> item, for every item rendered so far
  stats: null,
  ai: { enabled: null }, // from the server's /api/ai; null until known
  renderToken: 0,
};

// ---------- helpers ----------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
/** Third-party descriptions without their emoji (GitHub blurbs carry plenty); the words stay. */
const plain = (value) => String(value ?? "").replace(/\p{Extended_Pictographic}️?\s?/gu, "").trim();

function ago(iso) {
  if (!iso) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const SERVER_ROUTES = new Set(["/api/rank", "/api/ai", "/api/submit"]);
let localApiPromise = null;
let localData = null; // { catalog, getIndex } once the catalog has loaded

/** Downloads the catalog once and builds the search index in the browser. */
function localApi() {
  localApiPromise ??= (async () => {
    const res = await fetch("/catalog.json");
    if (!res.ok) throw new Error(`Could not load the catalog (${res.status})`);
    const catalog = buildCatalog(await res.json(), "catalog.json");
    // Listings only need the catalog; the search index (the slow part of startup) is built on the
    // first search, or while the browser is idle after the first page shows, whichever comes first.
    let index = null;
    const getIndex = () => (index ??= buildIndex(catalog.items));
    (window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(getIndex, { timeout: 4000 });
    localData = { catalog, getIndex };
    return createApi({
      state: () => ({
        catalog,
        get index() {
          return getIndex();
        },
      }),
      rerank: async () => null,
      aiStatus: () => state.ai,
      saveSubmission: async () => {
        throw new Error("submissions go to the server");
      },
    });
  })();
  localApiPromise.catch(() => (localApiPromise = null));
  return localApiPromise;
}

async function api(path, options) {
  const url = new URL(path, location.origin);
  if (!SERVER_ROUTES.has(url.pathname)) {
    const [status, body] = await (await localApi())("GET", url, async () => "");
    if (status >= 400) throw new Error(body.error || `Request failed (${status})`);
    return body;
  }
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function remember(items) {
  for (const item of items) if (item) state.items.set(item.id, item);
  return items;
}

let toastTimer;
let toastUndo = null;
/** Pass `undo` for a reversible action: the toast gets an UNDO button and stays up longer. */
function toast(message, undo = null) {
  $toast.textContent = message;
  toastUndo = undo;
  if (undo) $toast.insertAdjacentHTML("beforeend", `<button type="button" data-action="toast-undo" class="hit ml-3 underline underline-offset-2 font-semibold">Undo</button>`);
  $toast.classList.toggle("pointer-events-none", !undo);
  $toast.classList.remove("opacity-0", "-translate-y-2");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 5000 : 2200);
}

function hideToast() {
  toastUndo = null;
  $toast.classList.add("opacity-0", "-translate-y-2", "pointer-events-none");
}

/** Confirms a copy on the button that was clicked, where the user is looking. */
function flashCopied(button) {
  if (!button || button.tagName !== "BUTTON") return;
  clearTimeout(button._flash);
  button.dataset.label ??= button.innerHTML;
  button.innerHTML = "Copied";
  button._flash = setTimeout(() => {
    button.innerHTML = button.dataset.label;
    delete button.dataset.label;
  }, 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "explore";
  const [route, query = ""] = raw.split("?");
  return { route, params: new URLSearchParams(query) };
}

function hrefWith(route, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  return `#/${route}${qs ? `?${qs}` : ""}`;
}

// ---------- type words ----------

// Every screen follows the taste-skill app sheet "data-terminal" (styles.css): words in Geist, figures and
// code in JetBrains Mono, panels darker than the ground with a 1px edge, no cast shadows, and the accent
// only on a selection's 1px line and on data that moved.
const TYPE_META = {
  skill: { label: "Agent skill" },
  plugin: { label: "Plugin" },
  mcp: { label: "MCP server" },
  repo: { label: "GitHub repo" },
  prompt: { label: "Prompt" },
};

const LEVEL_LABEL = { beginner: "Easy setup", intermediate: "Some setup", expert: "Advanced" };

const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");

// ---------- shared components ----------

/** The screen's title row: one h1, an optional line about the data, and an optional stamp or action on the right. */
function titleRow(title, sub = "", right = "") {
  return `<div class="xp-title">
    <div class="min-w-0">
      <h1>${title}</h1>
      ${sub ? `<p class="xp-sub">${sub}</p>` : ""}
    </div>
    ${right}
  </div>`;
}

function searchConsole({ value = "", placeholder = "Describe a task in plain English", type = "" } = {}) {
  return `<form class="search-form xp-search" role="search" data-type="${esc(type)}">
    <label>
      <span class="sr-only">Search in plain English</span>
      <input name="q" value="${esc(value)}" type="search" autocomplete="off" enterkeyhint="search" placeholder="${esc(placeholder)}" aria-keyshortcuts="/ Control+K Meta+K" />
      <kbd title="Press / or Ctrl+K to search from any page">${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
    </label>
    <button type="submit" class="xp-btn">Search</button>
  </form>`;
}

/** A filter or a suggestion. Selected: ink label with the 1px accent line under it. */
function chip(label, { href, active = false, action, value } = {}) {
  const cls = `c-chip${active ? " is-active" : ""}`;
  if (href) return `<a class="${cls}" href="${esc(href)}"${active ? ' aria-current="true"' : ""}><span>${esc(label)}</span></a>`;
  return `<button type="button" class="${cls}" data-action="${esc(action)}" data-value="${esc(value)}"><span>${esc(label)}</span></button>`;
}

/** A row of chips that scrolls sideways on a phone instead of wrapping into a wall. */
function chipRow(label, chips) {
  return `<div class="c-chiprow">${label ? `<span class="c-chiprow-label">${esc(label)}</span>` : ""}${chips}</div>`;
}

const PAGE_SIZE = 30;

/** "Official only" / "Easy setup" toggles, plus optional sort tabs; each is a link that keeps the other params. */
function filterBar(route, params, { sorts = null } = {}) {
  const current = Object.fromEntries(params);
  delete current.limit;
  const toggle = (key, label) => chip(label, { href: hrefWith(route, { ...current, [key]: current[key] === "1" ? "" : "1" }), active: current[key] === "1" });
  const sortLinks = sorts
    ? sorts.map(([value, label], i) => chip(label, { href: hrefWith(route, { ...current, sort: i === 0 ? "" : value }), active: (current.sort || sorts[0][0]) === value })).join("")
    : "";
  return `<div class="c-filters">
    ${chipRow("Show", `${toggle("official", "Official only")}${toggle("easy", "Easy setup")}`)}
    ${sorts ? chipRow("Sort by", sortLinks) : ""}
  </div>`;
}

function showMoreLink(route, params, shown, total) {
  if (total <= shown) return "";
  return `<a href="${esc(hrefWith(route, { ...Object.fromEntries(params), limit: shown + PAGE_SIZE }))}" class="c-more">Show ${Math.min(PAGE_SIZE, total - shown)} more <span class="fig">· ${num(total - shown)} left</span></a>`;
}

/** Underline tabs on one full-width rule; the selected one carries the 1px accent line. */
function tabs(list) {
  return `<nav class="c-tabs" aria-label="Sections">${list
    .map(({ label, href, active, count }) => `<a href="${esc(href)}" class="${active ? "is-active" : ""}"${active ? ' aria-current="page"' : ""}><span>${esc(label)}</span>${count != null ? ` <span class="fig c-tab-count">${num(count)}</span>` : ""}</a>`)
    .join("")}</nav>`;
}

function sectionHeader(title, right = "") {
  return `<div class="xp-head"><h2>${title}</h2>${right}</div>`;
}

/** "+16,002 this week" from GitHub trending, or "New" for a young repo whose weekly figure is only an estimate. */
function trendBadge(item) {
  const t = item.trending;
  if (!t) return "";
  if (t.estimated) return `<span class="c-gain" title="A new repo gaining stars fast; the weekly figure is an estimate">New${t.createdAt ? ` · created ${esc(ago(t.createdAt))}` : ""}</span>`;
  return `<span class="c-gain" title="Stars gained this week, from GitHub trending"><span class="fig">+${num(t.weekly)}</span> this week</span>`;
}

function trustBadge(item) {
  const s = item.trust?.score ?? 0;
  return `<span class="c-trust" title="${esc((item.trust?.reasons ?? []).join(", ") || "Trust score from public signals")}">Trust <span class="fig">${s}</span></span>`;
}

/** One line under list headers, so the trust number on every card isn't a mystery. */
function trustLegend() {
  return `<p class="c-note">Trust (0–100) comes from public signals: official publisher, GitHub stars, recent updates and license. It isn't a security review, and installs are copy-only: nothing runs without you.</p>`;
}

function bookmarkButton(item) {
  const on = state.saved.has(item.id);
  return `<button type="button" data-action="save" data-id="${esc(item.id)}" aria-pressed="${on}" aria-label="${on ? "Remove from saved" : "Save"} ${esc(item.name)}" class="c-icon hit${on ? " is-on" : ""}">
    <span class="material-symbols-outlined text-[18px] ${on ? "icon-fill" : ""}" aria-hidden="true">bookmark</span>
  </button>`;
}

function whyLine(why, ai) {
  if (!why) return "";
  return `<p class="c-why${ai ? " is-ai" : ""}"><span class="c-why-label">${ai ? "Why it fits" : "Matched"}</span> ${esc(why)}</p>`;
}

const agentShort = (id) => state.agents.find((a) => a.id === id)?.short ?? id;

/** The agent whose install instructions a card shows: the picked agent if supported, else the first. */
function activeAgent(item) {
  const ids = Object.keys(item.installs ?? {});
  const tab = state.installTab.get(item.id);
  if (ids.includes(tab)) return tab;
  return ids.includes(state.agent) ? state.agent : ids[0];
}

/** Text the Copy install button puts on the clipboard for an agent. */
function installText(install) {
  if (install.kind === "steps") return install.value.join("\n");
  return install.value;
}

function installBody(install, agentId) {
  const beginner = state.level === "beginner";
  if (install.kind === "steps") {
    return `<ol class="c-steps">${install.value.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  }
  const where =
    install.kind === "config"
      ? `Add this to ${install.where}, then restart ${agentShort(agentId)}.`
      : install.where === "claude code"
        ? "Paste inside Claude Code (in the chat box)."
        : `Paste in your ${install.where} (not inside the AI chat).`;
  return `<p class="c-where">${esc(beginner ? where : install.where ?? "")}</p>
    <pre class="c-code">${esc(install.value)}</pre>
    ${beginner && install.steps?.length ? `<ol class="c-steps">${install.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    ${install.note ? `<p class="c-where">${esc(install.note)}</p>` : ""}`;
}

function installTabs(item, ids, active) {
  if (ids.length < 2) return "";
  return `<div class="c-agent-tabs" role="tablist">${ids
    .map((id) => `<button type="button" role="tab" aria-selected="${id === active}" data-action="install-tab" data-id="${esc(item.id)}" data-agent="${id}" class="${id === active ? "is-active" : ""}"><span>${esc(agentShort(id))}</span></button>`)
    .join("")}</div>`;
}

function installPanel(item) {
  const installs = item.installs ?? {};
  const ids = Object.keys(installs).filter((id) => installs[id].kind !== "prompt");
  if (!ids.length) return "";
  const active = activeAgent(item);
  return `<details class="c-install">
    <summary><span class="material-symbols-outlined text-[16px]" aria-hidden="true">chevron_right</span>${state.level === "beginner" ? `How do I add this to ${esc(agentShort(active))}?` : "Install"}</summary>
    <div class="c-install-body">
      ${installTabs(item, ids, active)}
      <div class="c-install-text" data-install-body="${esc(item.id)}">${installBody(installs[active], active)}</div>
      ${item.requires?.length ? `<p class="c-where">Needs ${item.requires.map(esc).join(" · ")}</p>` : ""}
    </div>
  </details>`;
}

function worksWith(item) {
  if (!item.agents?.length || item.type === "repo") return "";
  const all = state.agents.length && item.agents.length >= state.agents.length;
  return `<p class="c-meta">Works with ${all ? "every agent" : item.agents.map((a) => esc(agentShort(a))).join(" · ")}</p>`;
}

function tagLinks(item, route = "skills") {
  if (!item.tags.length) return "";
  return `<p class="c-tags">${item.tags
    .slice(0, 4)
    .map((t) => (route ? `<a href="${esc(hrefWith(route, { tag: t }))}">#${esc(t)}</a>` : `<span>#${esc(t)}</span>`))
    .join(" ")}</p>`;
}

/** The kind, the publisher's standing and the trust score: the first line of every card. */
function cardTop(item, kind = TYPE_META[item.type].label) {
  return `<div class="c-top"><span>${esc(kind)}${item.official ? ' · <span class="c-official">Official</span>' : ""}</span>${trustBadge(item)}</div>`;
}

function cardHead(item, subtitle) {
  return `<div class="c-head">
    <div class="min-w-0">
      <h3><a href="${esc(itemHref(item))}">${esc(item.name)}</a></h3>
      ${subtitle ? `<p class="c-meta">${esc(subtitle)}</p>` : ""}
    </div>
    ${bookmarkButton(item)}
  </div>`;
}

/** Figures and facts in one quiet line: stars, license, setup level, this week's gain. */
function factLine(parts) {
  const shown = parts.filter(Boolean);
  return shown.length ? `<p class="c-facts">${shown.join('<span class="c-dot" aria-hidden="true">·</span>')}</p>` : "";
}

// Card for skills, plugins and MCP servers.
function toolCard(item, { why, ai } = {}) {
  const subtitle = [item.marketplace && `From the ${item.marketplace} marketplace`, item.plugin && `Part of ${item.plugin}`, item.author && `By ${item.author}`].filter(Boolean)[0] ?? "";
  const facts = factLine([
    // Skills and plugins usually live in a bigger repo; the stars are that repo's, so say so.
    item.stars != null ? `<span title="${item.type === "mcp" ? "GitHub stars" : "Stars of the GitHub repo this comes from"}"><span class="fig">${num(item.stars)}</span> ${item.type === "mcp" ? "stars" : "repo stars"}</span>` : "",
    item.version ? `<span>v<span class="fig">${esc(item.version)}</span></span>` : "",
    item.license ? `<span>${esc(item.license)}</span>` : "",
    `<span>${LEVEL_LABEL[item.level]}</span>`,
    trendBadge(item),
  ]);
  const hasInstall = Object.keys(item.installs ?? {}).length;
  return `<article class="c-card">
    ${cardTop(item)}
    ${cardHead(item, subtitle)}
    <p class="c-summary">${esc(plain(item.summary || item.description))}</p>
    ${whyLine(why, ai)}
    ${facts}
    ${worksWith(item)}
    ${tagLinks(item)}
    ${installPanel(item)}
    <div class="c-actions">
      ${hasInstall ? `<button type="button" data-action="install" data-id="${esc(item.id)}" class="c-btn">Copy install</button>` : ""}
      ${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="c-link">Source ↗</a>` : ""}
    </div>
  </article>`;
}

// Card for GitHub repos.
function repoCard(item, { why, ai } = {}) {
  const [owner, name] = (item.repo ?? `/${item.name}`).split("/");
  const facts = factLine([
    item.stars != null ? `<span><span class="fig">${num(item.stars)}</span> stars</span>` : "",
    item.forks != null ? `<span><span class="fig">${num(item.forks)}</span> forks</span>` : "",
    item.license ? `<span>${esc(item.license)}</span>` : "",
    item.language ? `<span>${esc(item.language)}</span>` : "",
    item.pushedAt ? `<span>Pushed ${esc(ago(item.pushedAt))}</span>` : "",
    trendBadge(item),
  ]);
  return `<article class="c-card">
    ${cardTop(item)}
    ${cardHead({ ...item, name: name || item.name }, owner ? `By ${owner}` : "")}
    <p class="c-summary">${esc(plain(item.summary || item.description))}</p>
    ${whyLine(why, ai)}
    ${facts}
    ${tagLinks(item, null)}
    ${item.archived ? `<p class="c-warn">Archived: no longer maintained.</p>` : ""}
    <div class="c-actions">
      <button type="button" data-action="clone" data-id="${esc(item.id)}" class="c-btn">Copy clone command</button>
      ${item.url ? `<a class="c-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>` : ""}
    </div>
  </article>`;
}

// Chat apps that accept a prefilled prompt in the URL. Other agents get copy-only.
const PREFILL_URLS = {
  chatgpt: { label: "ChatGPT", url: (p) => `https://chatgpt.com/?q=${encodeURIComponent(p)}` },
  claude: { label: "Claude", url: (p) => `https://claude.ai/new?q=${encodeURIComponent(p)}` },
  "gemini-app": { label: "Gemini", url: () => "https://gemini.google.com/app", copyFirst: true },
};

function openInLink(prompt, id) {
  const target = PREFILL_URLS[state.agent] ?? (state.agent === "all" ? PREFILL_URLS.claude : null);
  if (!target) return "";
  const other = state.agent === "all" ? PREFILL_URLS.chatgpt : null;
  // Apps without a prefill URL get the prompt copied on the same click, ready to paste.
  const link = (t) =>
    `<a href="${esc(t.url(prompt))}" target="_blank" rel="noopener noreferrer" ${t.copyFirst ? `data-action="copy-prompt" data-id="${esc(id)}"` : ""} class="c-link">Open in ${t.label} ↗</a>`;
  return link(target) + (other ? link(other) : "");
}

const PROMPT_TABS = { writing: "Writing", work: "Work", learning: "Learning", life: "Everyday life", coding: "Coding" };

// Card for prompts.
function promptCard(item, { why, ai } = {}) {
  const kind = `${PROMPT_TABS[item.category] ?? "Prompt"} prompt`;
  return `<article class="c-card">
    <div class="c-top"><span>${esc(kind)} · ${LEVEL_LABEL[item.level]}</span><span class="c-meta">about <span class="fig">${num(Math.ceil((item.prompt ?? "").length / 4))}</span> tokens</span></div>
    ${cardHead(item, "")}
    <p class="c-summary">${esc(item.summary)}</p>
    ${whyLine(why, ai)}
    <p class="c-prompt">${esc(item.prompt)}</p>
    <div class="c-actions">
      <button type="button" data-action="copy-prompt" data-id="${esc(item.id)}" class="c-btn">Copy prompt</button>
      ${openInLink(item.prompt ?? "", item.id)}
    </div>
  </article>`;
}

function card(item, extra = {}) {
  if (item.type === "repo") return repoCard(item, extra);
  if (item.type === "prompt") return promptCard(item, extra);
  return toolCard(item, extra);
}

/** A quiet working line for something slow that isn't the page itself (AI ranking). */
function loadingBlock(label = "Searching the index") {
  return `<p class="c-loading" role="status"><span class="material-symbols-outlined text-[16px] animate-spin motion-reduce:animate-none" style="animation-duration:1.6s" aria-hidden="true">sync</span>${esc(label)}…</p>`;
}

/** Card-shaped placeholders, so a slow page keeps its layout instead of jumping when results arrive. */
function skeletonCards(label = "Loading", n = 4) {
  const bar = (size) => `<div class="${size} rounded bg-surface-container-high"></div>`;
  const one = `<div class="c-card">
    ${bar("w-1/3 h-3")}
    ${bar("w-2/5 h-5")}
    ${bar("w-full h-3")}${bar("w-4/5 h-3")}
    <div class="flex gap-2 pt-1">${bar("w-24 h-8")}${bar("w-16 h-8")}</div>
  </div>`;
  return `<div role="status" aria-label="${esc(label)}" class="animate-pulse motion-reduce:animate-none">${cardGrid(one.repeat(n))}</div>`;
}

/** A failure inside the block that failed: what went wrong, and a way to try again. */
function errorBlock(message) {
  return `<div role="alert" class="c-panel c-error">
    <p>Couldn't load this: ${esc(message)}</p>
    <button type="button" data-action="retry" class="c-link">Try again</button>
  </div>`;
}

/** An empty result keeps its frame: one sentence, then where to go next. */
function emptyBlock(message, hint = "") {
  return `<div class="c-panel c-empty">
    <p>${esc(message)}</p>
    ${hint}
  </div>`;
}

function textLink(label, href) {
  return `<a href="${esc(href)}" class="c-link">${esc(label)}</a>`;
}

// What each chat app can take, for empty states when the picked agent can't use a whole category.
const AGENT_CAN_USE = {
  chatgpt: "ChatGPT takes remote MCP servers (as custom connectors) and prompts, not skills or plugins.",
  claude: "The Claude app takes skills (uploaded as a .zip), remote MCP connectors and prompts. Plugins are for Claude Code.",
  "gemini-app": "The Gemini app only takes prompts. Pick Gemini CLI in the For menu for MCP servers and extensions.",
  windsurf: "Windsurf takes MCP servers and prompts.",
};

function noItemsBlock() {
  const limits = state.agent !== "all" && AGENT_CAN_USE[state.agent];
  return emptyBlock(limits ? `Nothing here for ${agentShort(state.agent)}. ${limits}` : "Nothing matches that filter.", textLink("Browse prompts", "#/prompts"));
}

/** A notice that sits above results: what a filter is hiding, or a question from the AI. */
function noticeBlock(html) {
  return `<div class="c-panel c-notice">${html}</div>`;
}

/** Card list: one column on phones, two side by side on desktop. */
function cardGrid(html) {
  return `<div class="c-grid">${html}</div>`;
}

function page(inner) {
  return `<div class="xp w-full px-space-md">${inner}</div>`;
}

// ---------- views ----------

const EXAMPLE_QUERIES = [
  "let my AI use a web browser",
  "make slides from my notes",
  "find out why my app keeps crashing",
  "up-to-date docs for the library I'm using",
  "connect ChatGPT to my database",
  "review my pull requests",
];

const STARTER_IDS = [
  "skill:anthropic-document-skills",
  "mcp:context7",
  "mcp:playwright",
  "prompt:claude-md-starter",
  "mcp:memory",
  "mcp:fetch",
  "skill:anthropic-example-skills",
  "repo:hesreallyhim/awesome-claude-code",
];

// Explore, laid out from the taste-skill app sheet "data-terminal" (styles.css, .xp-*). The screen's
// question is "what can I add to my AI for what I want to do?": the search box answers it and is the
// biggest control; the index strip, this week's risers and the most trusted tools answer what comes next.
const INDEX_CELLS = [
  { type: "skill", label: "Agent skills", note: "Teach your AI new tricks", href: () => hrefWith("skills", { type: "skill" }) },
  { type: "plugin", label: "Plugins", note: "Bundles for Claude Code and more", href: () => hrefWith("skills", { type: "plugin" }) },
  { type: "mcp", label: "MCP servers", note: "Connect apps and data", href: () => hrefWith("skills", { type: "mcp" }) },
  { type: "connector", label: "Connectors", note: "Paste a URL into Claude or ChatGPT", href: () => "#/connectors" },
  { type: "prompt", label: "Prompts", note: "Copy-paste instructions", href: () => "#/prompts" },
  { type: "repo", label: "GitHub repos", note: "Open-source stacks", href: () => "#/repos" },
];
const TYPE_WORD = { skill: "skill", plugin: "plugin", mcp: "MCP server", prompt: "prompt", repo: "repo" };

/** "29 Oct" for the freshness stamp; null when the catalog has no build date. */
function shortDate(iso) {
  const d = iso && new Date(iso);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
}

/** Who publishes it, from the repo owner or the listed author. */
function ownerOf(item) {
  return item.repo ? item.repo.split("/")[0] : item.author || "";
}

/** Opens the item's own card, with its install steps. */
function itemHref(item) {
  return hrefWith("item", { id: item.id });
}

/** One item by id: explore's rows land here, on exactly the tool that was listed. */
async function viewItem(params) {
  const data = await api(hrefApi("/api/items", { ids: params.get("id") ?? "" }));
  const item = remember(data.items)[0];
  if (!item) return page(emptyBlock("That item isn't in the index any more.", textLink("Back to explore", "#/explore")));
  document.title = `${item.name} · AI Deck`;
  const tag = item.tags[0];
  const like = tag ? await api(hrefApi("/api/items", { type: item.type, tag, sort: "trust", limit: 5 })) : { items: [] };
  const related = remember(like.items.filter((i) => i.id !== item.id)).slice(0, 4);
  return page(`<h1 class="sr-only">${esc(item.name)}</h1>
    <div class="c-item">${card(item)}</div>
    ${related.length ? `<section class="xp-section" aria-labelledby="related">${sectionHeader(`<span id="related">More ${esc(TYPE_META[item.type].label.toLowerCase())}s for #${esc(tag)}</span>`, textLink("See all", hrefWith(item.type === "repo" ? "repos" : item.type === "prompt" ? "prompts" : "skills", item.type === "repo" || item.type === "prompt" ? {} : { tag })))}${cardGrid(related.map((i) => card(i)).join(""))}</section>` : ""}`);
}

/** Search links in a run; each separator travels with the link after it, so no line ends on a "·". */
function linkRun(queries) {
  return queries
    .map((q, i) => `<span class="item">${i ? '<span class="sep" aria-hidden="true">·</span>' : ""}<a href="${esc(hrefWith("search", { q }))}">${esc(q)}</a></span>`)
    .join(" ");
}

function risingRow(item, { withSummary = false } = {}) {
  const t = item.trending;
  const gain = t?.estimated ? "new" : `+${t.weekly.toLocaleString("en-US")}`;
  const stars = item.stars != null ? item.stars.toLocaleString("en-US") : "—";
  const trust = String(item.trust?.score ?? "—");
  return `<a class="xp-row" href="${esc(itemHref(item))}">
    <span class="min-w-0">
      <span class="name">${esc(item.name)}</span>
      <span class="meta">${esc([ownerOf(item), TYPE_WORD[item.type]].filter(Boolean).join(" · "))}<span class="phone-only"> · <span class="fig">${stars}</span> stars · trust <span class="fig">${trust}</span></span></span>
    </span>
    ${withSummary ? `<span class="what desk-only">${esc(plain(item.summary || item.description))}</span>` : ""}
    <span class="num fig desk-only">${stars}</span>
    <span class="num fig gain" title="${t?.estimated ? "A young repo rising fast; the weekly figure is an estimate" : "Stars gained this week, from GitHub trending"}">${gain}</span>
    <span class="num fig desk-only">${trust}</span>
  </a>`;
}

function trustRow(item) {
  const trust = item.trust?.score ?? "—";
  const who = item.official ? `${ownerOf(item) || "Official"} · official` : ownerOf(item);
  return `<a class="xp-row" href="${esc(itemHref(item))}">
    <span class="min-w-0">
      <span class="name">${esc(item.name)}</span>
      <span class="meta">${esc([who, TYPE_WORD[item.type]].filter(Boolean).join(" · "))}</span>
    </span>
    <span class="num fig" title="${esc((item.trust?.reasons ?? []).join(", ") || "Trust score from public signals")}">${trust}</span>
  </a>`;
}

async function viewExplore() {
  const stats = state.stats ?? (state.stats = await api("/api/stats"));
  const c = { ...stats.counts, connector: stats.connectors };
  const total = ["skill", "plugin", "mcp", "prompt", "repo"].reduce((sum, t) => sum + (c[t] ?? 0), 0);
  const updated = shortDate(stats.generatedAt);

  const [trustRes, trendingRes] = await Promise.all([
    api(hrefApi("/api/items", { types: ["mcp", "plugin", "skill"], sort: "trust", limit: 12 })),
    api(hrefApi("/api/items", { sort: "trending", limit: 5 })),
  ]);
  // The same tool listed as a server and as its plugin shows once.
  const seen = new Set();
  const trusted = remember(trustRes.items).filter((i) => {
    const key = (i.repo || i.name).toLowerCase();
    return !seen.has(key) && seen.add(key);
  }).slice(0, 5);
  const rising = remember(trendingRes.items);
  const top = rising.find((i) => !i.trending?.estimated);

  const title = `<div class="xp-title">
      <div>
        <h1>What do you want your AI to do?</h1>
        <p class="xp-sub">Describe it in your own words. AI Deck searches <span class="fig">${total.toLocaleString("en-US")}</span> skills, plugins, MCP servers, prompts and repos, and shows how to install each one. New here? Start with the <a class="c-link" href="#/starter">starter kit</a>.</p>
      </div>
      ${updated ? `<p class="xp-stamp">Index updated ${esc(updated)}</p>` : ""}
    </div>`;

  const search = `${searchConsole()}
    <p class="xp-try"><span class="lead">Try</span> ${linkRun(EXAMPLE_QUERIES)}</p>`;

  const index = `<section aria-labelledby="xp-index">
      <div class="xp-head"><h2 id="xp-index">Browse the index</h2></div>
      <nav class="xp-strip" aria-label="Browse by type">${INDEX_CELLS.map(
        (cell) => `<a class="xp-cell" href="${esc(cell.href())}">
          <span class="label">${esc(cell.label)}</span>
          <span class="fig">${(c[cell.type] ?? 0).toLocaleString("en-US")}</span>
          <span class="note">${esc(cell.note)}</span>
        </a>`,
      ).join("")}</nav>
    </section>`;

  const risingHtml = rising.length
    ? `<section class="xp-rising" aria-labelledby="xp-rising">
        <div class="xp-head"><h2 id="xp-rising">Rising this week</h2><a href="#/trending">All <span class="fig">${trendingRes.total}</span></a></div>
        ${top ? `<p class="xp-finding">${esc(top.name)} gained <span class="fig">+${top.trending.weekly.toLocaleString("en-US")}</span> GitHub stars this week, the most of anything in the index. Stars show attention; check its trust score before you install.</p>` : ""}
        <div class="xp-panel">
          <div class="xp-row xp-cols" aria-hidden="true"><span>Name</span><span class="num">Stars</span><span class="num">This week</span><span class="num">Trust</span></div>
          ${rising.map(risingRow).join("")}
        </div>
      </section>`
    : "";

  const trustHtml = trusted.length
    ? `<section class="xp-trust" aria-labelledby="xp-trust">
        <div class="xp-head"><h2 id="xp-trust">Most trusted</h2><a href="${esc(hrefWith("skills", { sort: "trust" }))}">All by trust</a></div>
        <p class="xp-finding">Trust (0–100) comes from public signals: official publisher, stars, recent updates and license.</p>
        <div class="xp-panel">
          <div class="xp-row xp-cols" aria-hidden="true"><span>Name</span><span class="num">Trust</span></div>
          ${trusted.map(trustRow).join("")}
        </div>
      </section>`
    : "";

  const recent = state.recent.length
    ? `<section aria-labelledby="xp-recent">
        <div class="xp-head"><h2 id="xp-recent">Your recent searches</h2><button type="button" data-action="flush-recent">Clear</button></div>
        <p class="xp-recent">${linkRun(state.recent)}</p>
      </section>`
    : "";

  return page(`
    ${title}
    ${search}
    ${index}
    <div class="xp-pair">${risingHtml}${trustHtml}</div>
    ${recent}
  `);
}

/** API URL builder; scopes every listing and search to the agent picked in the header. */
function hrefApi(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null && v !== "") qs.set(k, v);
  }
  if (state.agent !== "all" && !params.ids) qs.set("agent", state.agent);
  return `${path}?${qs}`;
}

async function viewSearch(params, token, { live = false } = {}) {
  const q = (params.get("q") ?? "").trim();
  const type = params.get("type") ?? "";
  const typeTabs = tabs(
    [["", "All"], ["skill", "Skills"], ["plugin", "Plugins"], ["mcp", "MCP servers"], ["prompt", "Prompts"], ["repo", "Repos"]].map(([t, label]) => ({
      label,
      href: hrefWith("search", { q, type: t }),
      active: t === type,
    })),
  );
  const head = `<h1 class="sr-only">Search</h1>${searchConsole({ value: q, type })}${typeTabs}`;

  if (!q) {
    return page(`${head}
      <p class="xp-try"><span class="lead">Try</span> ${linkRun(EXAMPLE_QUERIES)}</p>`);
  }

  if (!live) pushRecent(q); // half-typed words shouldn't fill the recent list
  const limit = Math.min(300, Number(params.get("limit")) || PAGE_SIZE);
  const official = params.get("official") ?? "";
  const easy = params.get("easy") ?? "";
  const local = await api(hrefApi("/api/search", { q, type, level: state.level, limit, official, easy }));
  remember(local.results.map((r) => r.item));

  // A chat app can only use some types; say how much the agent filter is hiding instead of showing weak leftovers.
  let agentNote = "";
  if (state.agent !== "all") {
    const qs = new URLSearchParams({ q, level: state.level, limit: String(PAGE_SIZE) }); // same page size, so the count matches
    if (type) qs.set("type", type);
    const everyone = await api(`/api/search?${qs}`);
    if (everyone.total > Math.max(10, local.total * 3)) {
      agentNote = noticeBlock(`<p>${local.total ? `Showing what works in ${esc(agentShort(state.agent))}.` : `Nothing here works in ${esc(agentShort(state.agent))}.`} ${esc(AGENT_CAN_USE[state.agent] ?? "")}</p>
        <button type="button" data-action="agent-all" class="c-link">See all <span class="fig">${num(everyone.total)}</span> results for other AIs</button>`);
    }
  }

  const correction = local.intent.corrected
    ? `<p class="c-note">Showing results for <a href="${esc(hrefWith("search", { q: local.intent.corrected, type }))}" class="c-link">${esc(local.intent.corrected)}</a></p>`
    : "";
  const understood = local.intent.tags.length ? `<p class="c-note">Understood as ${local.intent.tags.slice(0, 6).map((t) => `<span class="c-tagword">#${esc(t)}</span>`).join(" ")}</p>` : "";

  const body = local.results.length
    ? `<div id="ai-slot">${state.ai.enabled === false ? "" : loadingBlock(`${state.ai.provider ?? "AI"} is ranking the best matches`)}</div>
       <section class="xp-section" id="local-results" aria-labelledby="matches">
         ${sectionHeader(`<span id="matches">Matches</span>`, `<span class="xp-stamp">Showing <span class="fig">${num(local.results.length)}</span> of <span class="fig">${num(local.total)}</span></span>`)}
         ${trustLegend()}
         ${cardGrid(local.results.map((r) => card(r.item, { why: r.why })).join(""))}
         ${showMoreLink("search", params, local.results.length, local.total)}
       </section>`
    : emptyBlock(
        official || easy
          ? "Nothing matched with these filters. Try turning off Official only or Easy setup."
          : "Nothing matched that yet. Try describing the task differently: what you want to happen, rather than a product name.",
        `<p class="xp-try"><span class="lead">Try</span> ${linkRun(EXAMPLE_QUERIES.slice(0, 3))}</p>`,
      );

  return {
    html: page(`${head}${filterBar("search", params)}${agentNote}${correction}${understood}${body}`),
    // Phase 2, once the page is in the DOM: ask the AI to rerank and explain, then patch #ai-slot.
    // Not on every keystroke: AI ranking costs a model call, so it waits for Enter.
    after: () => !live && local.results.length && enhanceWithAi(q, type, token, params),
  };
}

async function enhanceWithAi(q, type, token, params) {
  const slot = document.getElementById("ai-slot");
  if (!slot) return;
  try {
    const ranked = await api(hrefApi("/api/rank", { q, type, level: state.level, official: params.get("official") ?? "", easy: params.get("easy") ?? "" }));
    if (token !== state.renderToken) return;
    if (!ranked.ai) {
      slot.innerHTML = "";
      state.ai = { enabled: false, reason: ranked.reason };
      return;
    }
    remember(ranked.results.map((r) => r.item));
    const provider = esc(ranked.provider ?? "AI");
    const clarify = ranked.clarify
      ? noticeBlock(`<p><strong>${provider} asks:</strong> ${esc(ranked.clarify)} Add that to your search for sharper results.</p>`)
      : "";
    slot.innerHTML = ranked.results.length
      ? `<section class="xp-section" aria-labelledby="best-picks">
          ${sectionHeader(`<span id="best-picks">Best picks</span>`, `<span class="xp-stamp">Ranked by ${provider}</span>`)}
          ${clarify}
          ${cardGrid(ranked.results.map((r) => card(r.item, { why: r.why, ai: true })).join(""))}
        </section>`
      : clarify;
  } catch (error) {
    if (token === state.renderToken) slot.innerHTML = "";
    console.warn("AI ranking unavailable:", error);
  }
}

function pushRecent(q) {
  state.recent = [q, ...state.recent.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  writeStore("aideck.recent", state.recent);
}

const submitButton = `<button type="button" data-action="submit-open" class="c-btn">Submit a tool</button>`;

async function viewSkills(params) {
  const type = ["skill", "plugin", "mcp"].includes(params.get("type")) ? params.get("type") : "";
  const tag = params.get("tag") ?? "";
  const limit = Number(params.get("limit")) || PAGE_SIZE;
  const sort = ["trust", "updated", "stars"].includes(params.get("sort")) ? params.get("sort") : "trust";
  // Filters and sort survive switching tabs and tags.
  const keep = { official: params.get("official") ?? "", easy: params.get("easy") ?? "", sort: sort === "trust" ? "" : sort };
  const data = await api(hrefApi("/api/items", { type, types: type ? [] : ["skill", "plugin", "mcp"], tag, sort, limit, official: keep.official, easy: keep.easy }));
  remember(data.items);
  const c = state.stats?.counts ?? {};

  const typeTabs = tabs(
    [["", "All", (c.skill ?? 0) + (c.plugin ?? 0) + (c.mcp ?? 0)], ["skill", "Agent skills", c.skill], ["plugin", "Plugins", c.plugin], ["mcp", "MCP servers", c.mcp]].map(([t, label, count]) => ({
      label,
      count,
      href: hrefWith("skills", { ...keep, type: t, tag }),
      active: t === type,
    })),
  );
  const tagChips = data.tags.map(({ tag: t }) => chip(t, { href: hrefWith("skills", { ...keep, type, tag: t === tag ? "" : t }), active: t === tag })).join("");

  return page(`
    ${titleRow("Skills, plugins and MCP servers", `Add-ons that teach your AI new tasks or connect it to your apps and data. <span class="fig">${num(data.total)}</span> ${tag ? `tagged #${esc(tag)}` : "in this view"}.`, submitButton)}
    ${searchConsole({ placeholder: "Search skills, plugins and MCP servers", type })}
    ${typeTabs}
    ${chipRow("Topics", tagChips)}
    ${filterBar("skills", params, { sorts: [["trust", "Trust"], ["updated", "Recently updated"], ["stars", "Stars"]] })}
    ${trustLegend()}
    ${data.items.length ? cardGrid(data.items.map((item) => card(item)).join("")) : noItemsBlock()}
    ${data.total > data.items.length ? `<a href="${esc(hrefWith("skills", { ...keep, type, tag, limit: limit + PAGE_SIZE }))}" class="c-more">Show ${Math.min(PAGE_SIZE, data.total - data.items.length)} more <span class="fig">· ${num(data.total - data.items.length)} left</span></a>` : ""}
  `);
}

/** Copies a connector's URL; the URL is shown too, so it can be read and checked before pasting. */
function connectorRow(item) {
  const url = connectorUrl(item);
  return `<div class="xp-row c-conn-row">
    <a class="min-w-0" href="${esc(itemHref(item))}">
      <span class="name">${esc(item.name)}</span>
      <span class="meta">${esc([ownerOf(item), item.official ? "official" : ""].filter(Boolean).join(" · ") || "Community listing")}</span>
    </a>
    <code class="c-url" title="${esc(url)}">${esc(url)}</code>
    <span class="num fig">${item.trust?.score ?? "—"}</span>
    <button type="button" data-action="copy-url" data-id="${esc(item.id)}" class="c-btn c-btn-sm" aria-label="Copy the URL for ${esc(item.name)}">Copy URL</button>
  </div>`;
}

async function viewConnectors(params) {
  const tag = params.get("tag") ?? "";
  const limit = Number(params.get("limit")) || PAGE_SIZE;
  const official = params.get("official") ?? "";
  const data = await api(hrefApi("/api/items", { type: "mcp", remote: "1", tag, official, sort: "trust", limit }));
  remember(data.items);
  const steps = (app, list) => `<div class="c-panel c-howto"><h3>In ${app}</h3><ol class="c-steps">${list.map((s) => `<li>${s}</li>`).join("")}</ol></div>`;
  const tagChips = data.tags.map(({ tag: t }) => chip(t, { href: hrefWith("connectors", { official, tag: t === tag ? "" : t }), active: t === tag })).join("");

  return page(`
    ${titleRow("Connectors", `Remote MCP servers you add to the Claude app or ChatGPT by pasting a URL. Nothing to install; the server runs online. <span class="fig">${num(state.stats?.connectors ?? data.total)}</span> in the index.`)}
    <section class="xp-section" aria-labelledby="howto">
      ${sectionHeader(`<span id="howto">How to add one</span>`)}
      <div class="c-howto-pair">
        ${steps("Claude", ["Open <strong>Settings → Connectors</strong>", "Choose <strong>Add custom connector</strong>", "Paste the connector's URL and sign in if it asks"])}
        ${steps("ChatGPT", ["Open <strong>Settings → Apps &amp; Connectors → Advanced settings</strong> and turn on <strong>Developer mode</strong>", "Back in Apps &amp; Connectors, choose <strong>Create</strong> and name it", "Paste the connector's URL"])}
      </div>
    </section>
    <section class="xp-section xp-rising" aria-labelledby="conn-list">
      ${sectionHeader(`<span id="conn-list">${tag ? `Connectors tagged #${esc(tag)}` : "Most trusted connectors"}</span>`, `<span class="xp-stamp"><span class="fig">${num(data.total)}</span> listed</span>`)}
      ${chipRow("Show", chip("Official only", { href: hrefWith("connectors", { tag, official: official ? "" : "1" }), active: official === "1" }))}
      ${chipRow("Topics", tagChips)}
      <p class="c-note">Only add a connector you trust: it can read what you share with it in chat. Trust (0–100) comes from public signals, not a security review.</p>
      ${
        data.items.length
          ? `<div class="xp-panel c-conn">
              <div class="xp-row xp-cols c-conn-row" aria-hidden="true"><span>Name</span><span>URL</span><span class="num">Trust</span><span></span></div>
              ${data.items.map(connectorRow).join("")}
            </div>`
          : state.agent !== "all" && !["claude", "chatgpt"].includes(state.agent) && AGENT_CAN_USE[state.agent]
            ? noItemsBlock()
            : emptyBlock("No connectors with that filter.", textLink("Show all connectors", "#/connectors"))
      }
      ${showMoreLink("connectors", params, data.items.length, data.total)}
    </section>
  `);
}

async function viewTrending(params) {
  const limit = Number(params.get("limit")) || PAGE_SIZE;
  const data = await api(hrefApi("/api/items", { sort: "trending", limit }));
  remember(data.items);
  const updated = state.stats?.trendingAt ? `<p class="xp-stamp">Read from GitHub ${esc(ago(state.stats.trendingAt))}</p>` : "";
  return page(`
    ${titleRow("Trending this week", `AI repos gaining the most GitHub stars this week, from GitHub's trending pages. Stars show attention, not quality: check the trust score and the code before you install.`, updated)}
    ${
      data.items.length
        ? `<section class="xp-rising with-summary" aria-label="Trending repos"><div class="xp-panel">
            <div class="xp-row xp-cols" aria-hidden="true"><span>Name</span><span class="desk-only">What it is</span><span class="num">Stars</span><span class="num">This week</span><span class="num">Trust</span></div>
            ${data.items.map((item) => risingRow(item, { withSummary: true })).join("")}
          </div></section>`
        : noItemsBlock()
    }
    <p class="c-note">"New" marks a young repo rising fast, where the weekly number is an estimate.</p>
    ${showMoreLink("trending", params, data.items.length, data.total)}
  `);
}

async function viewRepos(params) {
  const sort = ["stars", "trending", "updated", "name"].includes(params.get("sort")) ? params.get("sort") : "stars";
  const language = params.get("language") ?? "";
  const data = await api(hrefApi("/api/items", { type: "repo", sort, language, limit: 60 }));
  remember(data.items);
  const sorts = [["stars", "Most stars"], ["trending", "Trending"], ["updated", "Recently pushed"], ["name", "A–Z"]];
  const langChips = [["", "All"], ...data.languages.map((l) => [l, l])].map(([l, label]) => chip(label, { href: hrefWith("repos", { sort, language: l }), active: l === language })).join("");
  return page(`
    ${titleRow("GitHub repos", `Open-source AI projects to clone and run. <span class="fig">${num(data.total)}</span> ${language ? `in ${esc(language)}` : "in the index"}${data.total > data.items.length ? `, top <span class="fig">${data.items.length}</span> shown` : ""}.`)}
    ${searchConsole({ placeholder: "What should the repo help you build?", type: "repo" })}
    ${tabs(sorts.map(([s, label]) => ({ label, href: hrefWith("repos", { sort: s, language }), active: s === sort })))}
    ${data.languages.length ? chipRow("Language", langChips) : ""}
    ${data.items.length ? cardGrid(data.items.map((item) => repoCard(item)).join("")) : emptyBlock("No repos in that language.", textLink("Show all languages", hrefWith("repos", { sort })))}
  `);
}

async function viewPrompts(params) {
  const category = Object.hasOwn(PROMPT_TABS, params.get("category")) ? params.get("category") : "";
  const data = await api(hrefApi("/api/items", { type: "prompt", category, sort: "name", limit: 100 }));
  remember(data.items);
  const categoryTabs = tabs([["", "All"], ...Object.entries(PROMPT_TABS)].map(([c, label]) => ({ label, href: hrefWith("prompts", { category: c }), active: c === category })));
  return page(`
    ${titleRow("Prompts", `Ready-made instructions to paste into any chat. <span class="fig">${num(data.total)}</span> ${category ? `for ${esc(PROMPT_TABS[category].toLowerCase())}` : "in all"}${state.level === "beginner" ? ", easiest first" : ""}.`)}
    ${searchConsole({ placeholder: "What should your AI write or do?", type: "prompt" })}
    ${categoryTabs}
    ${
      data.items.length
        ? cardGrid(
            data.items
              .sort((a, b) => (state.level === "beginner" ? levelRank(a) - levelRank(b) : 0))
              .map((item) => promptCard(item))
              .join(""),
          )
        : emptyBlock("No prompts in this category yet.", textLink("Show all prompts", "#/prompts"))
    }
  `);
}

const levelRank = (item) => ({ beginner: 0, intermediate: 1, expert: 2 })[item.level] ?? 1;

async function viewSaved() {
  const ids = [...state.saved];
  if (!ids.length) {
    const picks = remember((await api(hrefApi("/api/items", { ids: STARTER_IDS.join(",") }))).items);
    return page(`${titleRow("Saved", "Kept on this device.")}${emptyBlock("Nothing saved yet. Tap the bookmark on any card to keep it here.", textLink("Browse the index", "#/explore"))}
      <section class="xp-section" aria-labelledby="picks">${sectionHeader(`<span id="picks">Good first picks</span>`, textLink("Starter kit", "#/starter"))}${cardGrid(picks.map((item) => card(item)).join(""))}</section>`);
  }
  const data = await api(hrefApi("/api/items", { ids: ids.join(",") }));
  remember(data.items);
  return page(`${titleRow("Saved", `<span class="fig">${num(data.items.length)}</span> kept on this device.`)}
    ${cardGrid(data.items.map((item) => card(item)).join(""))}`);
}

async function viewStarter() {
  const data = await api(hrefApi("/api/items", { ids: STARTER_IDS.join(",") }));
  remember(data.items);
  return page(`
    ${titleRow(
      "New to AI add-ons?",
      `<strong>Skills</strong> teach an AI agent how to do a task. <strong>MCP servers</strong> connect it to apps and data, and work in Claude, ChatGPT, Gemini, Cursor and more. <strong>Plugins</strong> bundle several of these into one install. These <span class="fig">${data.items.length}</span> are easy, well-maintained picks to start with.`,
    )}
    ${cardGrid(data.items.map((item) => card(item)).join(""))}
  `);
}

const VIEWS = {
  explore: { label: "Explore", nav: "explore", render: viewExplore },
  search: { label: "Search", nav: null, render: viewSearch },
  skills: { label: "Skills", nav: "skills", render: viewSkills },
  connectors: { label: "Connectors", nav: "connectors", render: viewConnectors },
  prompts: { label: "Prompts", nav: "prompts", render: viewPrompts },
  repos: { label: "Repos", nav: "repos", render: viewRepos },
  saved: { label: "Saved", nav: "saved", render: viewSaved },
  starter: { label: "Starter Kit", nav: "explore", render: viewStarter },
  trending: { label: "Trending", nav: "explore", render: viewTrending },
  item: { label: "Item", nav: "explore", render: viewItem },
};

async function render() {
  const { route, params } = parseHash();
  const view = VIEWS[route] ?? VIEWS.explore;
  const token = ++state.renderToken;
  $sectionLabel.textContent = view.label;
  document.title = route === "explore" ? "AI Deck" : `${view.label} · AI Deck`;
  // The active destination: its label in full ink with a 1px accent line under it (styles.css).
  for (const link of document.querySelectorAll(".top-link, .nav-link")) {
    const active = link.dataset.path === view.nav;
    link.classList.toggle("is-active", active);
    link.classList.toggle("text-on-surface-variant", !active);
    link.classList.toggle("hover:text-on-surface", !active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  // A live render (search as you type) keeps the old results up until the new ones are ready.
  const live = state.live;
  state.live = false;
  // Most views render from the local catalog in a few ms: the old page stays up, and placeholders only
  // show if this one is slow, so fast navigations don't flash.
  const slow = live ? 0 : setTimeout(() => token === state.renderToken && ($view.innerHTML = page(skeletonCards())), 150);
  try {
    // Views return an HTML string, or { html, after } when they need to run once mounted.
    const out = await view.render(params, token, { live });
    clearTimeout(slow);
    if (token !== state.renderToken) return;
    // Carry over what's in the box right now, caret included: keys typed during the render aren't lost.
    const typing = live && document.activeElement?.matches(".search-form input") ? document.activeElement : null;
    const kept = typing && { value: typing.value, start: typing.selectionStart, end: typing.selectionEnd };
    swapView(() => {
      $view.innerHTML = typeof out === "string" ? out : out.html;
      if (kept) {
        const input = $view.querySelector(".search-form input");
        input.value = kept.value;
        input.focus();
        input.setSelectionRange(kept.start, kept.end);
      }
      if (nav.scroll != null) window.scrollTo({ top: nav.scroll });
      nav.scroll = null;
      if (nav.focusSearch) $view.querySelector(".search-form input")?.focus();
      nav.focusSearch = false;
      out.after?.();
    }, !live);
  } catch (error) {
    clearTimeout(slow);
    if (token !== state.renderToken) return;
    $view.innerHTML = page(errorBlock(error.message));
  }
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Cross-fades page changes where the browser supports it; typing-driven updates swap instantly. */
function swapView(mount, animate) {
  if (animate && document.startViewTransition && !reducedMotion.matches) document.startViewTransition(mount);
  else mount();
}

function renderLevel() {
  for (const btn of document.querySelectorAll(".level-btn")) {
    const active = btn.dataset.level === state.level;
    btn.classList.toggle("is-active", active);
    btn.classList.toggle("text-on-surface", active);
    btn.classList.toggle("text-on-surface-variant", !active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

// ---------- submit modal ----------

function openSubmitModal() {
  $modalRoot.innerHTML = `
  <div class="fixed inset-0 z-[55] bg-background/80 flex items-end sm:items-center justify-center sm:p-space-md" data-action="modal-backdrop">
    <form id="submit-form" role="dialog" aria-modal="true" aria-labelledby="submit-title" class="c-dialog p-space-lg pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-space-lg rounded-t-lg sm:rounded-lg w-full sm:max-w-md flex flex-col gap-4">
      <div data-sheet-handle class="sm:hidden -mt-space-sm -mx-space-lg pt-1 pb-space-xs flex justify-center touch-none cursor-grab" aria-hidden="true"><span class="w-10 h-1 rounded-full bg-outline-variant"></span></div>
      <div data-sheet-handle class="flex items-center justify-between touch-none sm:touch-auto">
        <h2 id="submit-title">Submit a tool</h2>
        <button type="button" data-action="modal-close" aria-label="Close" class="c-icon hit"><span class="material-symbols-outlined text-[18px]" aria-hidden="true">close</span></button>
      </div>
      <p class="c-note">Know a skill, plugin, MCP server, prompt or repo we're missing? Send the link; it's checked before it's listed.</p>
      <label class="c-field">Repo or manifest URL
        <input name="url" required type="url" pattern="https://.+" placeholder="https://github.com/org/mcp-server" />
      </label>
      <label class="c-field">Kind
        <select name="category">
          <option value="skill">Agent skill</option><option value="plugin">Plugin</option><option value="mcp">MCP server</option><option value="repo">GitHub repo</option><option value="prompt">Prompt</option>
        </select>
      </label>
      <label class="c-field">What does it help with? <span class="hint">Optional</span>
        <textarea name="note" rows="2" maxlength="500"></textarea>
      </label>
      <p id="submit-error" class="hidden c-warn"></p>
      <div class="flex items-center justify-end gap-4 pt-1">
        <button type="button" data-action="modal-close" class="c-link">Cancel</button>
        <button type="submit" class="xp-btn">Submit</button>
      </div>
    </form>
  </div>`;
  $modalRoot.querySelector("input")?.focus();
  swipeToDismiss($modalRoot.querySelector("#submit-form"));
}

/** Phone bottom sheet: drag it down by the handle or title row to close; a short drag springs back. */
function swipeToDismiss(sheet) {
  let start = null;
  sheet.addEventListener("pointerdown", (event) => {
    if (innerWidth >= 640 || !event.target.closest("[data-sheet-handle]") || event.target.closest("button")) return;
    start = { y: event.clientY, t: event.timeStamp };
    try {
      sheet.setPointerCapture(event.pointerId); // keep the drag when the finger leaves the handle
    } catch {
      // the pointer is already gone
    }
    sheet.style.transition = "none";
  });
  sheet.addEventListener("pointermove", (event) => {
    if (start) sheet.style.transform = `translateY(${Math.max(0, event.clientY - start.y)}px)`;
  });
  const end = (event) => {
    if (!start) return;
    const dy = event.clientY - start.y;
    const fast = dy / Math.max(1, event.timeStamp - start.t) > 0.5; // a quick flick closes too
    start = null;
    sheet.style.transition = "transform 200ms ease-out";
    if (dy > sheet.offsetHeight / 3 || (fast && dy > 30)) {
      sheet.style.transform = "translateY(100%)";
      setTimeout(closeModal, 180);
    } else {
      sheet.style.transform = "";
    }
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
}

function closeModal() {
  $modalRoot.innerHTML = "";
}

function setSaved(item, on) {
  if (on) state.saved.add(item.id);
  else state.saved.delete(item.id);
  writeStore("aideck.saved", [...state.saved]);
  for (const btn of document.querySelectorAll(`[data-action="save"][data-id="${CSS.escape(item.id)}"]`)) btn.outerHTML = bookmarkButton(item);
  if (parseHash().route === "saved") {
    state.live = true; // redraw the list in place: no fade, no placeholders, scroll kept
    render();
  }
}

// ---------- events ----------

// Search as you type on the search page: results follow the box after a short pause. replaceState, so
// Back skips the half-typed queries.
let liveTimer;
document.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.matches?.(".search-form input") || parseHash().route !== "search") return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    const q = input.value.trim();
    const { params } = parseHash();
    if (q === (params.get("q") ?? "").trim() || q.length === 1) return;
    history.replaceState(null, "", hrefWith("search", { ...Object.fromEntries(params), q, limit: null }));
    state.live = true;
    render();
  }, 250);
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.classList.contains("search-form")) {
    event.preventDefault();
    const q = new FormData(form).get("q").trim();
    clearTimeout(liveTimer);
    const next = hrefWith("search", { q, type: form.dataset.type });
    // Live search may already have put this query in the address bar: render anyway, as a full search.
    if (next === location.hash) render();
    else {
      nav.byLink = true; // a new search starts at the top
      location.hash = next;
    }
    return;
  }
  if (form.id === "submit-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const errorEl = form.querySelector("#submit-error");
    const button = form.querySelector('button[type="submit"]');
    // One request at a time: a double tap can't queue the same link twice (the server also dedupes by URL).
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const res = await api("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      closeModal();
      toast(res.duplicate ? "That one is already in the queue" : "Thanks. It goes in with the next index update");
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      button.disabled = false;
      button.textContent = "Submit";
    }
  }
});

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action],[data-level]");
  if (!el) return;

  if (el.dataset.level) {
    if (state.level === el.dataset.level) return;
    state.level = el.dataset.level;
    writeStore("aideck.level", state.level);
    renderLevel();
    toast(state.level === "beginner" ? "Explaining things for newcomers" : "Expert mode: less explaining");
    render();
    return;
  }

  const item = state.items.get(el.dataset.id);
  switch (el.dataset.action) {
    case "install": {
      if (!item) return;
      const agentId = activeAgent(item);
      const install = item.installs[agentId];
      await copyText(installText(install));
      flashCopied(el);
      break;
    }
    case "install-tab": {
      if (!item) return;
      state.installTab.set(item.id, el.dataset.agent);
      for (const panel of document.querySelectorAll(`[data-install-body="${CSS.escape(item.id)}"]`)) {
        panel.innerHTML = installBody(item.installs[el.dataset.agent], el.dataset.agent);
        for (const tab of panel.parentElement.querySelectorAll('[data-action="install-tab"]')) {
          const on = tab.dataset.agent === el.dataset.agent;
          tab.setAttribute("aria-selected", String(on));
          tab.classList.toggle("is-active", on);
        }
      }
      break;
    }
    case "copy-url": {
      const url = item && connectorUrl(item);
      if (!url) return;
      await copyText(url);
      flashCopied(el);
      break;
    }
    case "retry":
      render();
      break;
    case "clone":
      if (!item?.repo) return;
      await copyText(`git clone https://github.com/${item.repo}.git`);
      flashCopied(el);
      break;
    case "copy-prompt":
      if (!item) return;
      await copyText(item.prompt);
      if (el.tagName === "A") toast("Prompt copied: paste it into the chat");
      else flashCopied(el);
      break;
    case "save": {
      if (!item) return;
      const on = !state.saved.has(item.id);
      setSaved(item, on);
      if (on) toast("Saved");
      else toast("Removed from saved", () => setSaved(item, true));
      break;
    }
    case "toast-undo": {
      const undo = toastUndo;
      hideToast();
      undo?.();
      break;
    }
    case "agent-all":
      $agentSelect.value = "all";
      $agentSelect.dispatchEvent(new Event("change"));
      break;
    case "flush-recent":
      state.recent = [];
      writeStore("aideck.recent", []);
      render();
      break;
    case "submit-open":
      openSubmitModal();
      break;
    case "modal-close":
      closeModal();
      break;
    case "modal-backdrop":
      if (event.target === el) closeModal();
      break;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $modalRoot.innerHTML) closeModal();
  if ($modalRoot.innerHTML) return;
  const typing = /input|textarea|select/i.test(document.activeElement?.tagName ?? "");
  if ((event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
    event.preventDefault();
    focusSearch();
  }
});

// Back and Forward return to where you were on that page; following a link starts at the top.
history.scrollRestoration = "manual";
const nav = { scroll: null, focusSearch: false, byLink: false, positions: new Map() };
document.addEventListener("click", (event) => {
  if (event.target.closest('a[href^="#"]')) nav.byLink = true;
}, true);

window.addEventListener("hashchange", (event) => {
  nav.positions.set(new URL(event.oldURL).hash, window.scrollY);
  nav.scroll = nav.byLink ? 0 : nav.positions.get(location.hash) ?? 0;
  nav.byLink = false;
  render();
});

/** "/" or Ctrl/⌘+K: jump to the search box, opening the search page if this one has none. */
function focusSearch() {
  const input = $view.querySelector(".search-form input");
  if (input) {
    input.focus();
    input.select();
    return;
  }
  nav.byLink = true;
  nav.focusSearch = true;
  location.hash = "#/search";
}

$agentSelect.addEventListener("change", () => {
  state.agent = $agentSelect.value;
  state.installTab.clear();
  writeStore("aideck.agent", state.agent);
  toast(state.agent === "all" ? "Showing tools for every AI" : `Showing tools for ${agentShort(state.agent)}`);
  render();
});

async function boot() {
  renderLevel();
  $view.innerHTML = page(skeletonCards("Loading the index"));
  api("/api/ai")
    .then((ai) => (state.ai = ai))
    .catch(() => (state.ai = { enabled: false, reason: "server unavailable" }));
  try {
    state.stats = await api("/api/stats");
    state.agents = state.stats.agents;
    $agentSelect.insertAdjacentHTML("beforeend", state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.short)}</option>`).join(""));
    if (!state.agents.some((a) => a.id === state.agent)) state.agent = "all";
    $agentSelect.value = state.agent;
  } catch {
    // render() shows the error for the current view.
  }
  render();
}

boot();
