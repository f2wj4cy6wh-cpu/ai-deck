// AI Deck front end. Vanilla ES module, hash routing, markup and classes taken from the
// Stitch "AI Developer Resource Hub Deck" screens.
//
// Search and listings run in the browser over /catalog.json using the same modules as the server
// (copied to /lib by scripts/build-web.js). Only AI ranking and submissions go to the server.
import { buildCatalog } from "./lib/catalog.js";
import { buildIndex } from "./lib/search.js";
import { createApi } from "./lib/api.js";

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

function fmt(n) {
  if (typeof n !== "number") return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

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
  $toast.textContent = `> ${message}`;
  toastUndo = undo;
  if (undo) $toast.insertAdjacentHTML("beforeend", `<button type="button" data-action="toast-undo" class="hit ml-3 underline underline-offset-2 font-bold">UNDO</button>`);
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
  button.innerHTML = "COPIED ✓";
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

// ---------- type styling (folder-tab colors from the design doc) ----------

const TYPE_META = {
  skill: { label: "Agent Skill", icon: "psychology", tab: "bg-secondary-container text-on-secondary-container", accent: "text-secondary", ext: ".SKL" },
  plugin: { label: "Plugin", icon: "extension", tab: "bg-tertiary-container text-on-tertiary-container", accent: "text-tertiary", ext: ".PLG" },
  mcp: { label: "MCP Server", icon: "hub", tab: "bg-primary text-on-primary", accent: "text-primary", ext: ".MCP" },
  repo: { label: "GitHub Repo", icon: "fork_right", tab: "bg-repo text-on-repo", accent: "text-repo", ext: ".GIT" },
  prompt: { label: "Prompt", icon: "auto_awesome", tab: "bg-primary-container text-on-primary-container", accent: "text-primary", ext: ".PRM" },
};

const LEVEL_LABEL = { beginner: "EASY", intermediate: "SOME SETUP", expert: "ADVANCED" };

// ---------- shared components ----------

function searchConsole({ value = "", placeholder = "Describe what you want your AI to do...", type = "" } = {}) {
  return `
  <form class="search-form relative w-full" role="search" data-type="${esc(type)}">
    <div class="flex items-center gap-space-xs bg-surface-container-low p-space-xs rounded-lg shadow-[3px_3px_0px_#000000] focus-within:shadow-[3px_3px_0px_#10b981] transition-shadow">
      <label class="flex items-center flex-1 px-space-sm py-2 bg-surface-container-lowest rounded min-w-0">
        <span class="font-label-code text-label-code text-primary mr-space-xs select-none" aria-hidden="true">&gt;_</span>
        <span class="sr-only">Search in plain English</span>
        <input name="q" value="${esc(value)}" autocomplete="off" enterkeyhint="search" class="w-full bg-transparent font-body-md text-body-md text-on-surface placeholder:text-outline focus:outline-none min-w-0" placeholder="${esc(placeholder)}" type="search" aria-keyshortcuts="/ Control+K Meta+K" />
        <kbd class="hidden lg:inline-block ml-space-xs px-1.5 py-0.5 rounded bg-surface-container-high text-outline font-label-code text-label-sm whitespace-nowrap" title="Press / or Ctrl+K to search from any page">${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
      </label>
      <button class="press flex items-center justify-center gap-1 bg-primary text-on-primary font-label-code text-label-code px-3 py-2.5 rounded shadow-[2px_2px_0px_#000000]" type="submit">
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">keyboard_return</span><span>[RUN]</span>
      </button>
    </div>
  </form>`;
}

function chip(label, { href, active = false, action, value, tone = "" } = {}) {
  const base = "press shrink-0 px-2.5 py-1 font-label-code text-label-sm rounded shadow-[1px_1px_0px_#000000] whitespace-nowrap";
  const look = active ? "bg-primary text-on-primary" : `bg-surface-container-low ${tone || "text-on-surface"} hover:text-primary`;
  if (href) return `<a class="${base} ${look}" href="${esc(href)}"${active ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
  return `<button type="button" class="${base} ${look}" data-action="${esc(action)}" data-value="${esc(value)}">${esc(label)}</button>`;
}

const PAGE_SIZE = 30;

/** "Official only" / "Easy setup" toggles, plus optional sort chips; each is a link that keeps the other params. */
function filterBar(route, params, { sorts = null } = {}) {
  const current = Object.fromEntries(params);
  delete current.limit;
  const toggle = (key, label) => chip(`[ ${label} ]`, { href: hrefWith(route, { ...current, [key]: current[key] === "1" ? "" : "1" }), active: current[key] === "1" });
  const sortChips = sorts
    ? sorts.map(([value, label], i) => chip(label, { href: hrefWith(route, { ...current, sort: i === 0 ? "" : value }), active: (current.sort || sorts[0][0]) === value })).join("")
    : "";
  return `<div class="flex flex-wrap items-center gap-space-xs">
    <span class="font-label-code text-label-sm text-on-surface-variant tracking-widest uppercase">FILTER:</span>${toggle("official", "OFFICIAL ONLY")}${toggle("easy", "EASY SETUP")}
    ${sorts ? `<span class="font-label-code text-label-sm text-on-surface-variant tracking-widest uppercase ml-space-xs">SORT:</span>${sortChips}` : ""}
  </div>`;
}

function showMoreLink(route, params, shown, total) {
  if (total <= shown) return "";
  return `<a href="${esc(hrefWith(route, { ...Object.fromEntries(params), limit: shown + PAGE_SIZE }))}" class="press block text-center py-2 bg-surface-container-high text-primary font-label-code text-label-code rounded shadow-[2px_2px_0px_#000000]">[ SHOW MORE // ${total - shown} LEFT ]</a>`;
}

function tabButton(label, { href, active }) {
  const look = active
    ? "bg-primary text-on-primary shadow-[2px_2px_0px_#000000]"
    : "bg-surface-container-high text-on-surface hover:text-primary shadow-[2px_2px_0px_#000000]";
  return `<a href="${esc(href)}" class="press shrink-0 px-3 py-1.5 font-label-code text-label-code uppercase tracking-wider rounded flex items-center gap-1.5 ${look}"${active ? ' aria-current="page"' : ""}>${active ? '<span class="w-1.5 h-1.5 bg-on-primary rounded-full" aria-hidden="true"></span>' : ""}[ ${esc(label)} ]</a>`;
}

function sectionHeader(title, right = "") {
  return `<div class="flex items-center justify-between pt-1">
    <h2 class="font-headline-sm text-headline-sm text-on-surface uppercase tracking-tight">${esc(title)}</h2>
    ${right}
  </div>`;
}

/** "+16k this week" from GitHub trending, or "NEW" for a young repo whose weekly figure is only an estimate. */
function trendBadge(item) {
  const t = item.trending;
  if (!t) return "";
  if (t.estimated) {
    const since = t.createdAt ? ` · created ${ago(t.createdAt)}` : "";
    return `<span class="flex items-center gap-1 text-secondary font-bold" title="A new repo gaining stars fast"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">bolt</span>NEW${since}</span>`;
  }
  return `<span class="flex items-center gap-1 text-secondary font-bold" title="Stars gained this week, from GitHub trending"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">trending_up</span>+${fmt(t.weekly)} this week</span>`;
}

function trustBadge(item) {
  if (item.official) return `<span class="text-primary font-bold">● OFFICIAL</span>`;
  const s = item.trust?.score ?? 0;
  const tone = s >= 70 ? "text-primary" : s >= 50 ? "text-secondary" : "text-outline";
  return `<span class="${tone} font-bold" title="${esc((item.trust?.reasons ?? []).join(", ") || "Trust score from objective signals")}">● TRUST ${s}/100</span>`;
}

/** One line under list headers, so the trust number on every card isn't a mystery. */
function trustLegend() {
  return `<p class="font-body-sm text-body-sm text-outline -mt-space-sm">Trust (0–100) comes from public signals: official publisher, GitHub stars, recent updates, license. It isn't a security review.</p>`;
}

function bookmarkButton(item) {
  const on = state.saved.has(item.id);
  return `<button type="button" data-action="save" data-id="${esc(item.id)}" aria-pressed="${on}" aria-label="${on ? "Remove from saved" : "Save"} ${esc(item.name)}" class="press hit w-8 h-8 shrink-0 flex items-center justify-center bg-surface-container ${on ? "text-primary" : "text-on-surface-variant"} hover:text-primary shadow-[1px_1px_0px_#000000] rounded">
    <span class="material-symbols-outlined text-[18px] ${on ? "icon-fill" : ""}" aria-hidden="true">bookmark</span>
  </button>`;
}

function whyLine(why, ai) {
  if (!why) return "";
  return `<p class="flex gap-1.5 font-body-sm text-body-sm ${ai ? "text-primary-fixed" : "text-on-surface-variant"} bg-surface-container-lowest rounded px-2 py-1.5">
    <span class="material-symbols-outlined text-[14px] mt-px ${ai ? "text-primary" : "text-outline"}" aria-hidden="true">${ai ? "auto_awesome" : "subdirectory_arrow_right"}</span>
    <span>${esc(why)}</span>
  </p>`;
}

const agentShort = (id) => state.agents.find((a) => a.id === id)?.short ?? id;

/** The agent whose install instructions a card shows: the picked agent if supported, else the first. */
function activeAgent(item) {
  const ids = Object.keys(item.installs ?? {});
  const tab = state.installTab.get(item.id);
  if (ids.includes(tab)) return tab;
  return ids.includes(state.agent) ? state.agent : ids[0];
}

/** Text the COPY INSTALL button puts on the clipboard for an agent. */
function installText(install) {
  if (install.kind === "steps") return install.value.join("\n");
  return install.value;
}

function installBody(install, agentId) {
  const beginner = state.level === "beginner";
  if (install.kind === "steps") {
    return `<ol class="list-decimal pl-5 font-body-sm text-body-sm text-on-surface-variant space-y-0.5">${install.value.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  }
  const where =
    install.kind === "config"
      ? `Add this to ${install.where}, then restart ${agentShort(agentId)}.`
      : install.where === "claude code"
        ? "Paste inside Claude Code (in the chat box)."
        : `Paste in your ${install.where} (not inside the AI chat).`;
  return `${beginner ? `<p class="font-body-sm text-body-sm text-on-surface-variant">${esc(where)}</p>` : `<p class="font-label-code text-label-sm text-outline uppercase">${esc(install.where ?? "")}</p>`}
    <pre class="bg-surface-container-lowest rounded p-space-sm font-label-code text-[11px] leading-relaxed text-primary whitespace-pre-wrap break-all">${esc(install.value)}</pre>
    ${beginner && install.steps?.length ? `<ol class="list-decimal pl-5 font-body-sm text-body-sm text-on-surface-variant space-y-0.5">${install.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    ${install.note ? `<p class="font-body-sm text-body-sm text-secondary">${esc(install.note)}</p>` : ""}`;
}

function installPanel(item) {
  const installs = item.installs ?? {};
  const ids = Object.keys(installs).filter((id) => installs[id].kind !== "prompt");
  if (!ids.length) return "";
  const active = activeAgent(item);
  const tabs =
    ids.length > 1
      ? `<div class="flex flex-wrap gap-1" role="tablist">${ids
          .map(
            (id) =>
              `<button type="button" role="tab" aria-selected="${id === active}" data-action="install-tab" data-id="${esc(item.id)}" data-agent="${id}" class="px-2 py-0.5 rounded font-label-code text-label-sm uppercase ${id === active ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}">${esc(agentShort(id))}</button>`,
          )
          .join("")}</div>`
      : "";
  return `<details class="group">
    <summary class="list-none cursor-pointer font-label-code text-label-sm text-on-surface-variant hover:text-primary flex items-center gap-1 uppercase">
      <span class="material-symbols-outlined text-[14px] group-open:rotate-90 transition-transform" aria-hidden="true">chevron_right</span>
      ${state.level === "beginner" ? `How do I add this to ${esc(agentShort(active))}?` : "Install"}
    </summary>
    <div class="mt-space-xs flex flex-col gap-space-xs">
      ${tabs}
      <div class="flex flex-col gap-space-xs" data-install-body="${esc(item.id)}">${installBody(installs[active], active)}</div>
      ${item.requires?.length ? `<p class="font-label-code text-label-sm text-secondary uppercase">Needs: ${item.requires.map(esc).join(" · ")}</p>` : ""}
    </div>
  </details>`;
}

function worksWith(item) {
  if (!item.agents?.length || item.type === "repo") return "";
  const all = state.agents.length && item.agents.length >= state.agents.length;
  return `<p class="font-label-code text-label-sm text-on-surface-variant uppercase tracking-wide"><span class="text-outline">WORKS WITH:</span> ${all ? "All agents" : item.agents.map((a) => esc(agentShort(a))).join(" · ")}</p>`;
}

// Card for skills, plugins and MCP servers ("Skills & Plugins Directory" screen).
function toolCard(item, { why, ai } = {}) {
  const meta = TYPE_META[item.type];
  const telemetry = [
    // Skills and plugins usually live in a bigger repo; the stars are that repo's, so say so.
    item.stars != null
      ? `<span class="flex items-center gap-1 text-on-surface" title="${item.type === "mcp" ? "GitHub stars" : "Stars of the GitHub repo this comes from"}"><span class="material-symbols-outlined text-[14px] text-secondary" aria-hidden="true">star</span>${fmt(item.stars)}${item.type === "mcp" ? "" : ' <span class="text-outline">repo</span>'}</span>`
      : "",
    item.version ? `<span class="text-on-surface">v${esc(item.version)}</span>` : "",
    item.license ? `<span class="text-primary font-bold">${esc(item.license)}</span>` : "",
    `<span class="text-on-surface-variant">${LEVEL_LABEL[item.level]}</span>`,
    trendBadge(item),
  ].filter(Boolean);
  const subtitle = [item.marketplace && `@${item.marketplace}`, item.plugin && `in ${item.plugin}`, item.author].filter(Boolean)[0] ?? "";
  return `<article class="flex flex-col relative">
    <div class="flex items-end justify-between px-space-xs">
      <div class="flex items-center ${meta.tab} px-3 py-1 rounded-t shadow-[2px_0px_0px_#000000] translate-y-[1px]">
        <span class="font-label-code text-label-code uppercase tracking-wide flex items-center gap-1 font-bold">
          <span class="material-symbols-outlined text-[14px]" aria-hidden="true">${meta.icon}</span>${meta.label}
        </span>
      </div>
      <div class="font-label-code text-label-sm tracking-widest flex items-center gap-1.5 pb-1">
        ${trustBadge(item)}
      </div>
    </div>
    <div class="bg-surface-container-low p-space-md rounded rounded-tl-none shadow-[3px_3px_0px_#000000] flex flex-col gap-space-sm">
      <div class="flex items-start justify-between gap-space-sm">
        <div class="flex flex-col min-w-0">
          <h3 class="font-headline-sm text-headline-sm text-on-surface tracking-tight flex items-center gap-1.5 break-words">
            ${esc(item.name)}${item.official ? '<span class="material-symbols-outlined text-primary text-[18px] icon-fill" title="Official publisher" aria-label="Official publisher">verified</span>' : ""}
          </h3>
          ${subtitle ? `<span class="font-label-code text-label-sm ${meta.accent} tracking-wider uppercase mt-0.5 truncate">${esc(subtitle)}</span>` : ""}
        </div>
        ${bookmarkButton(item)}
      </div>
      <p class="font-body-md text-body-md text-on-surface-variant">${esc(item.summary || item.description)}</p>
      ${whyLine(why, ai)}
      ${worksWith(item)}
      ${item.tags.length ? `<div class="flex flex-wrap gap-space-xs">${item.tags.slice(0, 4).map((t) => `<a href="${esc(hrefWith("skills", { tag: t }))}" class="px-2 py-0.5 bg-surface-container-high text-primary font-label-code text-label-sm rounded hover:bg-surface-container-highest">#${esc(t)}</a>`).join("")}</div>` : ""}
      ${installPanel(item)}
      <div class="pt-space-xs flex items-center justify-between gap-space-sm flex-wrap">
        <div class="flex items-center gap-space-sm font-label-code text-label-sm text-on-surface-variant flex-wrap">${telemetry.join('<span class="text-outline">/</span>')}</div>
        <div class="flex items-center gap-space-xs">
          ${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="press px-2.5 py-1.5 bg-surface-container-high text-on-surface font-label-code text-label-code rounded shadow-[2px_2px_0px_#000000] hover:text-primary" aria-label="Open source for ${esc(item.name)}">↗</a>` : ""}
          ${Object.keys(item.installs ?? {}).length ? `<button type="button" data-action="install" data-id="${esc(item.id)}" class="press px-3.5 py-1.5 bg-primary text-on-primary font-label-code text-label-code rounded shadow-[3px_3px_0px_#000000] uppercase font-bold tracking-wider">[ COPY INSTALL ]</button>` : ""}
        </div>
      </div>
    </div>
  </article>`;
}

// Card for GitHub repos ("GitHub AI Repos Radar" screen).
function repoCard(item, { why, ai } = {}) {
  const [owner, name] = (item.repo ?? `/${item.name}`).split("/");
  const signals = [
    item.stars != null && `<span class="px-1.5 py-0.5 bg-surface-container-high text-secondary font-label-code text-label-code rounded shadow-[1px_1px_0px_#000000]">★ ${fmt(item.stars)}</span>`,
    item.forks != null && `<span class="px-1.5 py-0.5 bg-surface-container-high text-on-surface-variant font-label-code text-label-code rounded shadow-[1px_1px_0px_#000000]">⑂ ${fmt(item.forks)}</span>`,
    item.license && `<span class="px-1.5 py-0.5 bg-surface-container-high text-primary font-label-code text-label-code rounded shadow-[1px_1px_0px_#000000]">● ${esc(item.license)}</span>`,
    item.language && `<span class="px-1.5 py-0.5 bg-surface-container-highest text-on-surface font-label-code text-label-code rounded">${esc(item.language)}</span>`,
    item.pushedAt && `<span class="px-1.5 py-0.5 text-on-surface-variant font-label-code text-label-code">pushed ${ago(item.pushedAt)}</span>`,
    item.trending && `<span class="px-1.5 py-0.5 font-label-code text-label-code">${trendBadge(item)}</span>`,
  ].filter(Boolean);
  return `<article class="relative pt-3">
    <div class="absolute top-0 left-3 px-space-sm py-0.5 bg-repo text-on-repo font-label-code text-label-code uppercase tracking-wider rounded-t shadow-[2px_0px_0px_#000000]">DIR://${esc((item.tags[0] ?? "repo").toUpperCase().replace(/[^A-Z0-9]+/g, "_"))}</div>
    <div class="bg-surface-container-low rounded p-space-md shadow-[3px_3px_0px_#000000] flex flex-col gap-space-sm">
      <div class="flex items-start justify-between gap-space-sm">
        <div class="min-w-0">
          <span class="font-label-sm text-label-sm text-on-surface-variant block truncate">${esc(owner)} /</span>
          <h3 class="font-headline-sm text-headline-sm text-on-surface font-bold tracking-tight truncate">${esc(name || item.name)}</h3>
        </div>
        ${bookmarkButton(item)}
      </div>
      ${signals.length ? `<div class="flex flex-wrap items-center gap-space-xs">${signals.join("")}</div>` : ""}
      <p class="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">${esc(item.summary || item.description)}</p>
      ${whyLine(why, ai)}
      <div class="flex flex-wrap gap-space-xs">${item.tags.slice(0, 4).map((t) => `<span class="font-label-sm text-label-sm text-primary">#${esc(t)}</span>`).join("")}</div>
      ${item.archived ? `<p class="font-label-code text-label-sm text-error uppercase">Archived: no longer maintained</p>` : ""}
      <div class="grid grid-cols-2 gap-gutter-sm">
        <a class="press flex items-center justify-center py-1.5 px-space-xs bg-primary text-on-primary font-label-code text-label-code uppercase rounded shadow-[2px_2px_0px_#000000]" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">[ VIEW REPO ↗ ]</a>
        <button type="button" data-action="clone" data-id="${esc(item.id)}" class="press flex items-center justify-center py-1.5 px-space-xs bg-surface-container-high text-on-surface hover:text-primary font-label-code text-label-code uppercase rounded shadow-[2px_2px_0px_#000000]">[ CLONE ]</button>
      </div>
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
  const button = (t, primary) =>
    `<a href="${esc(t.url(prompt))}" target="_blank" rel="noopener noreferrer" ${t.copyFirst ? `data-action="copy-prompt" data-id="${esc(id)}"` : ""} class="press flex-1 flex items-center justify-center gap-1.5 ${primary ? "bg-primary-container text-on-primary-container" : "bg-surface-container-high text-on-surface"} font-label-code text-label-code py-2 rounded-lg shadow-[2px_2px_0px_#000000]">
      <span class="material-symbols-outlined text-[15px]" aria-hidden="true">play_arrow</span><span>[ ${t.label.toUpperCase()} ]</span>
    </a>`;
  return button(target, true) + (other ? button(other, false) : "");
}

const PROMPT_TABS = { writing: "Writing", work: "Work", learning: "Learning", life: "Everyday life", coding: "Coding" };

// Card for prompts ("Prompts Library" screen).
function promptCard(item, { why, ai } = {}) {
  return `<article class="flex flex-col relative w-full pt-4">
    <div class="absolute top-0 left-3 flex items-center gap-1.5 bg-primary px-3 py-0.5 rounded-t-lg shadow-[2px_0px_0px_#000000]">
      <span class="material-symbols-outlined text-on-primary text-[14px]" aria-hidden="true">psychology</span>
      <span class="font-label-code text-label-code text-on-primary font-bold uppercase tracking-wider">${esc((item.category ?? "prompt").toUpperCase())} // ${LEVEL_LABEL[item.level]}</span>
    </div>
    <div class="w-full bg-surface-container-low rounded-lg p-space-md shadow-[3px_3px_0px_#000000] flex flex-col gap-space-sm">
      <div class="flex items-start justify-between gap-space-xs mt-1">
        <div class="flex flex-col min-w-0">
          <h3 class="font-headline-sm text-headline-sm text-on-surface tracking-tight">${esc(item.name)}</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${esc(item.summary)}</p>
        </div>
        ${bookmarkButton(item)}
      </div>
      ${whyLine(why, ai)}
      <div class="bg-surface-container-highest/80 rounded-lg p-space-sm">
        <div class="flex items-center justify-between pb-1 mb-1">
          <span class="font-label-code text-outline tracking-widest text-[9px]">PROMPT.MD</span>
          <span class="font-label-sm text-label-sm text-primary">~${Math.ceil((item.prompt ?? "").length / 4)} TOKENS</span>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant line-clamp-4 leading-relaxed whitespace-pre-line">${esc(item.prompt)}</p>
      </div>
      <div class="flex items-center gap-2 pt-1">
        <button type="button" data-action="copy-prompt" data-id="${esc(item.id)}" class="press flex-1 flex items-center justify-center gap-1.5 bg-surface-container-high text-on-surface font-label-code text-label-code py-2 rounded-lg shadow-[2px_2px_0px_#000000]">
          <span class="material-symbols-outlined text-[15px]" aria-hidden="true">content_copy</span><span>[ COPY PROMPT ]</span>
        </button>
        ${openInLink(item.prompt ?? "", item.id)}
      </div>
    </div>
  </article>`;
}

function card(item, extra = {}) {
  if (item.type === "repo") return repoCard(item, extra);
  if (item.type === "prompt") return promptCard(item, extra);
  return toolCard(item, extra);
}

function loadingBlock(label = "QUERYING INDEX") {
  return `<div class="bg-surface-container-lowest p-space-sm rounded shadow-[2px_2px_0px_#000000] font-label-code text-label-code text-on-surface-variant flex items-center gap-2">
    <span class="material-symbols-outlined text-primary text-[16px] animate-spin" style="animation-duration:1.6s" aria-hidden="true">sync</span>${esc(label)}...
  </div>`;
}

/** Card-shaped placeholders, so a slow page keeps its layout instead of jumping when results arrive. */
function skeletonCards(label = "Loading", n = 4) {
  const bar = (size) => `<div class="${size} rounded bg-surface-container-high"></div>`;
  const one = `<div class="bg-surface-container-low rounded-lg p-space-md shadow-[3px_3px_0px_#000000] flex flex-col gap-space-sm">
    <div class="flex items-center gap-space-sm">${bar("w-8 h-8")}${bar("w-2/5 h-4")}</div>
    ${bar("w-full h-3")}${bar("w-4/5 h-3")}
    <div class="flex gap-2 pt-1">${bar("w-16 h-5")}${bar("w-12 h-5")}</div>
  </div>`;
  return `<div role="status" aria-label="${esc(label)}" class="animate-pulse motion-reduce:animate-none">${cardGrid(one.repeat(n))}</div>`;
}

function errorBlock(message) {
  return `<div role="alert" class="bg-error-container text-on-error-container p-space-sm rounded shadow-[2px_2px_0px_#000000] font-label-code text-label-code">ERR: ${esc(message)}</div>`;
}

function emptyBlock(message, hint = "") {
  return `<div class="bg-surface-container-lowest p-space-md rounded shadow-[2px_2px_0px_#000000] flex flex-col gap-1">
    <p class="font-label-code text-label-code text-secondary">&gt; 0 RESULTS</p>
    <p class="font-body-md text-body-md text-on-surface-variant">${esc(message)}</p>
    ${hint}
  </div>`;
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
  return emptyBlock(limits ? `Nothing here for ${agentShort(state.agent)}. ${limits}` : "No items with that filter.", `<a href="#/prompts" class="font-label-code text-label-code text-primary pt-1">[ BROWSE PROMPTS ]</a>`);
}

/** Card list: one column on phones, two side by side on desktop. */
function cardGrid(html) {
  return `<div class="grid grid-cols-1 lg:grid-cols-2 gap-space-lg items-start">${html}</div>`;
}

function page(inner) {
  return `<div class="flex flex-col w-full px-space-md space-y-space-lg">${inner}</div>`;
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
  { type: "prompt", label: "Prompts", note: "Copy-paste instructions", href: () => "#/prompts" },
  { type: "repo", label: "GitHub repos", note: "Open-source stacks", href: () => "#/repos" },
  { type: "starter", label: "Starter kit", note: "New here? Start with these", href: () => "#/starter" },
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
  if (!item) return page(emptyBlock("That item isn't in the index any more.", `<a href="#/explore" class="font-label-code text-label-code text-primary pt-1">[ BACK TO EXPLORE ]</a>`));
  document.title = `${item.name} · AI Deck`;
  return page(card(item));
}

/** Search links in a run; each separator travels with the link after it, so no line ends on a "·". */
function linkRun(queries) {
  return queries
    .map((q, i) => `<span class="item">${i ? '<span class="sep" aria-hidden="true">·</span>' : ""}<a href="${esc(hrefWith("search", { q }))}">${esc(q)}</a></span>`)
    .join(" ");
}

function risingRow(item) {
  const t = item.trending;
  const gain = t?.estimated ? "new" : `+${t.weekly.toLocaleString("en-US")}`;
  const stars = item.stars != null ? item.stars.toLocaleString("en-US") : "—";
  const trust = String(item.trust?.score ?? "—");
  return `<a class="xp-row" href="${esc(itemHref(item))}">
    <span class="min-w-0">
      <span class="name">${esc(item.name)}</span>
      <span class="meta">${esc([ownerOf(item), TYPE_WORD[item.type]].filter(Boolean).join(" · "))}<span class="phone-only"> · <span class="fig">${stars}</span> stars · trust <span class="fig">${trust}</span></span></span>
    </span>
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
  const c = { ...stats.counts, starter: STARTER_IDS.length };
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
        <p class="xp-sub">Describe it in your own words. AI Deck searches <span class="fig">${total.toLocaleString("en-US")}</span> skills, plugins, MCP servers, prompts and repos, and shows how to install each one.</p>
      </div>
      ${updated ? `<p class="xp-stamp">Index updated ${esc(updated)}</p>` : ""}
    </div>`;

  const search = `<form class="search-form xp-search" role="search">
      <label>
        <span class="sr-only">Search in plain English</span>
        <input name="q" type="search" autocomplete="off" enterkeyhint="search" placeholder="Describe a task in plain English" aria-keyshortcuts="/ Control+K Meta+K" />
        <kbd title="Press / or Ctrl+K to search from any page">${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
      </label>
      <button type="submit" class="xp-btn">Search</button>
    </form>
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

  return page(`<div class="xp">
    ${title}
    ${search}
    ${index}
    <div class="xp-pair">${risingHtml}${trustHtml}</div>
    ${recent}
  </div>`);
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
  const typeTabs = [["", "All"], ["skill", "Skills"], ["plugin", "Plugins"], ["mcp", "MCP"], ["prompt", "Prompts"], ["repo", "Repos"]]
    .map(([t, label]) => tabButton(label, { href: hrefWith("search", { q, type: t }), active: t === type }))
    .join("");
  const head = `${searchConsole({ value: q, type })}
    <div class="overflow-x-auto no-scrollbar -mx-space-md px-space-md py-1"><div class="flex items-center gap-space-xs min-w-max">${typeTabs}</div></div>`;

  if (!q) {
    return page(`${head}
      <div class="flex flex-col gap-space-xs">
        <span class="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-widest">Describe a task, for example:</span>
        <div class="flex flex-wrap gap-2">${EXAMPLE_QUERIES.map((ex) => chip(ex, { href: hrefWith("search", { q: ex, type }) })).join("")}</div>
      </div>`);
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
      agentNote = `<div class="bg-surface-container-high rounded p-space-sm shadow-[2px_2px_0px_#000000] font-body-md text-body-md text-on-surface flex gap-2">
        <span class="material-symbols-outlined text-secondary text-[18px]" aria-hidden="true">filter_alt</span>
        <span>${local.total ? `Showing what works in ${esc(agentShort(state.agent))}.` : `Nothing here works in ${esc(agentShort(state.agent))}.`} ${esc(AGENT_CAN_USE[state.agent] ?? "")}
        <button type="button" data-action="agent-all" class="text-primary font-bold underline underline-offset-2">See all ${everyone.total} results for other AIs</button></span>
      </div>`;
    }
  }

  const correction = local.intent.corrected
    ? `<p class="font-body-sm text-body-sm text-on-surface-variant">Showing results for <a href="${esc(hrefWith("search", { q: local.intent.corrected, type }))}" class="text-primary font-bold">${esc(local.intent.corrected)}</a></p>`
    : "";
  const intentChips = local.intent.tags.length
    ? `<div class="flex items-center gap-space-xs overflow-x-auto no-scrollbar lg:flex-wrap lg:overflow-visible"><span class="font-label-code text-label-sm text-on-surface-variant tracking-widest uppercase shrink-0">UNDERSTOOD:</span>${local.intent.tags.slice(0, 6).map((t) => `<span class="shrink-0 px-2 py-0.5 bg-surface-container-high text-primary font-label-code text-label-sm rounded">#${esc(t)}</span>`).join("")}</div>`
    : "";

  const body = local.results.length
    ? `<div id="ai-slot">${state.ai.enabled === false ? "" : loadingBlock(`${(state.ai.provider ?? "AI").toUpperCase()} IS RANKING THE BEST MATCHES`)}</div>
       <div class="flex flex-col gap-space-lg" id="local-results">
         ${sectionHeader(`Index Matches // ${local.total}`, `<span class="font-label-code text-label-code text-on-surface-variant">SHOWING ${local.results.length} OF ${local.total}</span>`)}
         ${trustLegend()}
         ${cardGrid(local.results.map((r) => card(r.item, { why: r.why })).join(""))}
         ${showMoreLink("search", params, local.results.length, local.total)}
       </div>`
    : emptyBlock(
        official || easy
          ? "Nothing matched with these filters. Try turning off Official only or Easy setup."
          : "Nothing matched that yet. Try describing the task differently, e.g. what you want to happen rather than a product name.",
        `<div class="flex flex-wrap gap-2 pt-1">${EXAMPLE_QUERIES.slice(0, 3).map((ex) => chip(ex, { href: hrefWith("search", { q: ex }) })).join("")}</div>`,
      );

  return {
    html: page(`${head}${filterBar("search", params)}${agentNote}${correction}${intentChips}${body}`),
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
    const clarify = ranked.clarify
      ? `<div class="bg-surface-container-high rounded p-space-sm shadow-[2px_2px_0px_#000000] font-body-md text-body-md text-on-surface flex gap-2"><span class="material-symbols-outlined text-secondary text-[18px]" aria-hidden="true">help</span><span><span class="font-label-code text-label-code text-secondary block">${esc((ranked.provider ?? "AI").toUpperCase())} ASKS</span>${esc(ranked.clarify)} <span class="text-on-surface-variant">Add that to your search for sharper results.</span></span></div>`
      : "";
    slot.innerHTML = ranked.results.length
      ? `<div class="flex flex-col gap-space-lg pb-space-lg">
          ${sectionHeader("Best Picks", `<span class="font-label-code text-label-code text-primary">[ ${esc((ranked.provider ?? "AI").toUpperCase())}_RANKED ]</span>`)}
          ${clarify}
          ${cardGrid(ranked.results.map((r) => card(r.item, { why: r.why, ai: true })).join(""))}
        </div>`
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

async function viewSkills(params) {
  const type = ["skill", "plugin", "mcp"].includes(params.get("type")) ? params.get("type") : "";
  const tag = params.get("tag") ?? "";
  const limit = Number(params.get("limit")) || PAGE_SIZE;
  const sort = ["trust", "updated", "stars"].includes(params.get("sort")) ? params.get("sort") : "trust";
  // Filters and sort survive switching tabs and tags.
  const keep = { official: params.get("official") ?? "", easy: params.get("easy") ?? "", sort: sort === "trust" ? "" : sort };
  const data = await api(hrefApi("/api/items", { type, types: type ? [] : ["skill", "plugin", "mcp"], tag, sort, limit, official: keep.official, easy: keep.easy }));
  remember(data.items);

  const tabs = [["", "All"], ["skill", "Agent Skills"], ["plugin", "Plugins"], ["mcp", "MCP Servers"]]
    .map(([t, label]) => tabButton(label, { href: hrefWith("skills", { ...keep, type: t, tag }), active: t === type }))
    .join("");
  const tagChips = data.tags.map(({ tag: t }) => chip(`[ ${t} ]`, { href: hrefWith("skills", { ...keep, type, tag: t === tag ? "" : t }), active: t === tag })).join("");

  return `
  <div class="px-space-md py-space-xs bg-surface-container-lowest flex items-center justify-between text-on-surface-variant font-label-code text-label-code">
    <span class="flex items-center gap-space-xs"><span class="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" aria-hidden="true"></span><span class="text-primary uppercase tracking-wider">DECK_NET://ONLINE</span></span>
    <span class="font-label-sm text-label-sm">SHOWING: <strong class="text-on-surface">${data.total}</strong></span>
  </div>
  ${page(`
    <div class="pt-space-sm">${searchConsole({ placeholder: "grep skills, plugins, mcp in plain English...", type })}</div>
    <div class="overflow-x-auto no-scrollbar -mx-space-md px-space-md"><div class="flex items-center gap-space-xs min-w-max pb-1">${tabs}</div></div>
    <div class="flex items-center gap-space-xs overflow-x-auto no-scrollbar pb-1 lg:flex-wrap lg:overflow-visible">
      <span class="text-on-surface-variant font-label-code text-label-sm tracking-widest uppercase shrink-0">TAGS:</span>${tagChips}
    </div>
    ${filterBar("skills", params, { sorts: [["trust", "TRUST"], ["updated", "RECENTLY UPDATED"], ["stars", "STARS"]] })}
    ${trustLegend()}
    ${data.items.length ? cardGrid(data.items.map((item) => card(item)).join("")) : noItemsBlock()}
    ${data.total > data.items.length ? `<a href="${esc(hrefWith("skills", { ...keep, type, tag, limit: limit + PAGE_SIZE }))}" class="press block text-center py-2 bg-surface-container-high text-primary font-label-code text-label-code rounded shadow-[2px_2px_0px_#000000]">[ LOAD MORE // ${data.total - data.items.length} LEFT ]</a>` : ""}
    <div class="bg-surface-container-lowest p-space-sm rounded shadow-[2px_2px_0px_#000000] flex flex-col gap-1 font-label-code text-label-sm text-on-surface-variant">
      <span class="text-primary flex items-center gap-1"><span class="material-symbols-outlined text-[12px]" aria-hidden="true">code</span>SYS_AUDIT_LOG</span>
      <p><span class="text-secondary">&gt;</span> trust scores use stars, recency, license and publisher only</p>
      <p><span class="text-primary">&gt;</span> installs are copy-only: nothing runs without you</p>
    </div>
  `)}
  <div class="fixed bottom-20 right-4 z-40 sm:right-[max(1rem,calc(50vw-21rem))]">
    <button type="button" data-action="submit-open" class="press px-4 py-2.5 bg-secondary text-on-secondary font-label-code text-label-code rounded shadow-[4px_4px_0px_#000000] hover:bg-secondary-fixed flex items-center gap-2 uppercase font-bold tracking-wider">
      <span class="material-symbols-outlined text-[18px]" aria-hidden="true">add_box</span><span>+ Submit</span>
    </button>
  </div>`;
}

async function viewTrending(params) {
  const limit = Number(params.get("limit")) || PAGE_SIZE;
  const data = await api(hrefApi("/api/items", { sort: "trending", limit }));
  remember(data.items);
  const updated = state.stats?.trendingAt ? `UPDATED ${ago(state.stats.trendingAt).toUpperCase()}` : "";
  return page(`
    ${sectionHeader(`Trending // ${data.total}`, `<span class="font-label-code text-label-code text-on-surface-variant">${esc(updated)}</span>`)}
    <p class="font-body-sm text-body-sm text-outline -mt-space-sm">AI repos gaining the most GitHub stars this week, read from GitHub's trending pages. "New" marks young repos rising fast, where the weekly number is an estimate. Stars show attention, not quality: check the trust score and the code before you install.</p>
    ${data.items.length ? cardGrid(data.items.map((item) => card(item)).join("")) : noItemsBlock()}
    ${showMoreLink("trending", params, data.items.length, data.total)}
  `);
}

async function viewRepos(params) {
  const sort = ["stars", "trending", "updated", "name"].includes(params.get("sort")) ? params.get("sort") : "stars";
  const language = params.get("language") ?? "";
  const data = await api(hrefApi("/api/items", { type: "repo", sort, language, limit: 60 }));
  remember(data.items);
  const sorts = [["stars", "Most stars"], ["trending", "Trending"], ["updated", "Recently pushed"], ["name", "A–Z"]];
  return page(`
    <div class="flex items-center justify-between bg-surface-container-high px-space-sm py-space-xs rounded shadow-[2px_2px_0px_#000000]">
      <span class="flex items-center gap-space-xs"><span class="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" aria-hidden="true"></span><span class="font-label-code text-label-code text-primary uppercase">RADAR_STREAM</span></span>
      <span class="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider">INDEX: GITHUB_AI // ${data.total}</span>
    </div>
    ${searchConsole({ placeholder: "find repos: what should it help you build?", type: "repo" })}
    <div class="flex flex-col gap-space-xs">
      <span class="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-widest">[ SORT ]</span>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-gutter-sm">${sorts
        .map(([s, label]) => {
          const active = s === sort;
          return `<a href="${esc(hrefWith("repos", { sort: s, language }))}" class="press py-1 px-space-xs text-center ${active ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"} font-label-code text-label-code uppercase rounded shadow-[2px_2px_0px_#000000]"${active ? ' aria-current="true"' : ""}>[ ${label} ]</a>`;
        })
        .join("")}</div>
    </div>
    ${data.languages.length ? `<div class="flex items-center gap-space-xs overflow-x-auto no-scrollbar pb-space-sm lg:flex-wrap lg:overflow-visible"><span class="font-label-sm text-label-sm text-on-surface-variant uppercase shrink-0 mr-space-xs">[LANG]:</span>${[["", "All"], ...data.languages.map((l) => [l, l])].map(([l, label]) => chip(label, { href: hrefWith("repos", { sort, language: l }), active: l === language })).join("")}</div>` : ""}
    ${data.items.length ? cardGrid(data.items.map((item) => repoCard(item)).join("")) : emptyBlock("No repos for that language.")}
  `);
}

async function viewPrompts(params) {
  const category = Object.hasOwn(PROMPT_TABS, params.get("category")) ? params.get("category") : "";
  const data = await api(hrefApi("/api/items", { type: "prompt", category, sort: "name", limit: 100 }));
  remember(data.items);
  const tabs = [["", "All"], ...Object.entries(PROMPT_TABS)]
    .map(([c, label]) => tabButton(label, { href: hrefWith("prompts", { category: c }), active: c === category }))
    .join("");
  return page(`
    ${searchConsole({ placeholder: "grep prompts: what should your AI write or do?", type: "prompt" })}
    <div class="overflow-x-auto no-scrollbar -mx-space-md px-space-md py-1"><div class="flex items-center gap-1.5 min-w-max">${tabs}</div></div>
    <div class="flex items-center justify-between px-space-xs font-label-sm text-label-sm text-on-surface-variant">
      <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-primary inline-block" aria-hidden="true"></span><span class="uppercase tracking-wider">INDEX: ${String(data.total).padStart(2, "0")}_PROMPT_BLOCKS</span></span>
      <span class="font-label-code text-label-code text-secondary">● ${state.level === "beginner" ? "EASIEST FIRST" : "ALL LEVELS"}</span>
    </div>
    ${cardGrid(
      data.items
        .sort((a, b) => (state.level === "beginner" ? levelRank(a) - levelRank(b) : 0))
        .map((item) => promptCard(item))
        .join(""),
    )}
    <div class="pt-2 pb-4 flex items-center justify-center gap-2"><span class="h-1 w-6 bg-surface-container-high rounded-full"></span><span class="font-label-code text-label-code text-outline">// END OF DECK RECORD //</span><span class="h-1 w-6 bg-surface-container-high rounded-full"></span></div>
  `);
}

const levelRank = (item) => ({ beginner: 0, intermediate: 1, expert: 2 })[item.level] ?? 1;

async function viewSaved() {
  const ids = [...state.saved];
  if (!ids.length) {
    return page(`${sectionHeader("Saved", "")}${emptyBlock("Nothing saved yet. Tap the bookmark on any card to keep it here.", `<a href="#/explore" class="font-label-code text-label-code text-primary pt-1">[ BROWSE THE DECK ]</a>`)}`);
  }
  const data = await api(hrefApi("/api/items", { ids: ids.join(",") }));
  remember(data.items);
  return page(`${sectionHeader(`Saved // ${data.items.length}`, `<span class="font-label-code text-label-code text-on-surface-variant">THIS DEVICE</span>`)}
    ${cardGrid(data.items.map((item) => card(item)).join(""))}`);
}

async function viewStarter() {
  const data = await api(hrefApi("/api/items", { ids: STARTER_IDS.join(",") }));
  remember(data.items);
  return page(`
    <div class="bg-surface-container-low rounded-lg p-space-md shadow-[3px_3px_0px_#000000] space-y-1">
      <span class="font-label-code text-label-code text-primary">[ STARTER_KIT ]</span>
      <h1 class="font-headline-md text-headline-md text-on-surface">New to AI add-ons?</h1>
      <p class="font-body-md text-body-md text-on-surface-variant"><strong class="text-on-surface">Skills</strong> teach an AI agent how to do a task. <strong class="text-on-surface">MCP servers</strong> connect it to apps and data (they work in Claude, ChatGPT, Gemini, Cursor and more). <strong class="text-on-surface">Plugins</strong> bundle several of these into one install. These are easy, well-maintained picks to start with.</p>
    </div>
    ${cardGrid(data.items.map((item) => card(item)).join(""))}
  `);
}

const VIEWS = {
  explore: { label: "Explore", nav: "explore", render: viewExplore },
  search: { label: "Search", nav: null, render: viewSearch },
  skills: { label: "Skills", nav: "skills", render: viewSkills },
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
  <div class="fixed inset-0 z-[55] bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-space-md" data-action="modal-backdrop">
    <form id="submit-form" role="dialog" aria-modal="true" aria-labelledby="submit-title" class="bg-surface-container p-space-lg pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-space-lg rounded-t-lg sm:rounded shadow-[6px_6px_0px_#000000] w-full sm:max-w-sm flex flex-col gap-space-md">
      <div data-sheet-handle class="sm:hidden -mt-space-sm -mx-space-lg pt-1 pb-space-xs flex justify-center touch-none cursor-grab" aria-hidden="true"><span class="w-10 h-1 rounded-full bg-outline-variant"></span></div>
      <div data-sheet-handle class="flex items-center justify-between touch-none sm:touch-auto">
        <h2 id="submit-title" class="flex items-center gap-1.5 font-label-code text-label-code text-primary uppercase"><span class="material-symbols-outlined text-[18px]" aria-hidden="true">upload</span>SUBMIT_TO_INDEX</h2>
        <button type="button" data-action="modal-close" aria-label="Close" class="hit w-8 h-8 flex items-center justify-center bg-surface-container-high text-on-surface hover:text-error"><span class="material-symbols-outlined text-[16px]" aria-hidden="true">close</span></button>
      </div>
      <label class="flex flex-col gap-space-xs">
        <span class="font-label-code text-label-sm text-on-surface-variant uppercase">Repo or manifest URL</span>
        <input name="url" required type="url" pattern="https://.+" placeholder="https://github.com/org/mcp-server" class="bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface rounded shadow-[2px_2px_0px_#000000] focus:outline-none focus:shadow-[2px_2px_0px_#10b981]" />
      </label>
      <label class="flex flex-col gap-space-xs">
        <span class="font-label-code text-label-sm text-on-surface-variant uppercase">Category</span>
        <select name="category" class="bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface rounded shadow-[2px_2px_0px_#000000] focus:outline-none">
          <option value="skill">Agent Skill</option><option value="plugin">Plugin</option><option value="mcp">MCP Server</option><option value="repo">GitHub Repo</option><option value="prompt">Prompt</option>
        </select>
      </label>
      <label class="flex flex-col gap-space-xs">
        <span class="font-label-code text-label-sm text-on-surface-variant uppercase">What does it help with? (optional)</span>
        <textarea name="note" rows="2" maxlength="500" class="bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface rounded shadow-[2px_2px_0px_#000000] focus:outline-none"></textarea>
      </label>
      <p id="submit-error" class="hidden font-label-code text-label-sm text-error"></p>
      <div class="flex items-center justify-end gap-space-sm pt-space-xs">
        <button type="button" data-action="modal-close" class="px-3 py-1.5 font-label-code text-label-code text-on-surface-variant uppercase">[ Cancel ]</button>
        <button type="submit" class="press px-4 py-1.5 bg-primary text-on-primary font-label-code text-label-code uppercase font-bold shadow-[2px_2px_0px_#000000]">[ Submit ]</button>
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
    button.textContent = "[ SENDING... ]";
    try {
      const res = await api("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      closeModal();
      toast(res.duplicate ? "ALREADY IN THE QUEUE" : "QUEUED FOR NEXT INGEST // ACK");
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      button.disabled = false;
      button.textContent = "[ Submit ]";
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
    toast(state.level === "beginner" ? "MODE: NEW TO THIS" : "MODE: EXPERT");
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
          tab.classList.toggle("bg-primary", on);
          tab.classList.toggle("text-on-primary", on);
          tab.classList.toggle("bg-surface-container-high", !on);
          tab.classList.toggle("text-on-surface-variant", !on);
        }
      }
      break;
    }
    case "clone":
      if (!item?.repo) return;
      await copyText(`git clone https://github.com/${item.repo}.git`);
      flashCopied(el);
      break;
    case "copy-prompt":
      if (!item) return;
      await copyText(item.prompt);
      if (el.tagName === "A") toast("PROMPT COPIED: PASTE IT INTO THE CHAT");
      else flashCopied(el);
      break;
    case "save": {
      if (!item) return;
      const on = !state.saved.has(item.id);
      setSaved(item, on);
      if (on) toast("SAVED TO COLLECTION");
      else toast("REMOVED FROM SAVED", () => setSaved(item, true));
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
  toast(state.agent === "all" ? "SHOWING: ALL AGENTS" : `SHOWING: ${agentShort(state.agent)}`);
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
