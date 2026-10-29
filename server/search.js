// Local (no-LLM) search: plain-English intent expansion + BM25 over weighted fields.
// This always runs; the Claude reranker in ai.js only reorders and annotates its output.
import { agentInQuery } from "./agents.js";

const STOPWORDS = new Set(
  ("a an and are as at be but by can claude could do does for from get give help how i in into is it its " +
    "me my need of on or please some something that the this to tool tools use want way what when which " +
    "with would you your let lets make able thing things find any connect ai " +
    // Rating words ("best mcp servers") would otherwise match "best-practices" and the like.
    "best top good great nice popular recommended better cool useful").split(" "),
);

// Everyday phrases -> catalog vocabulary. Keys are regexes over the raw query.
// Patterns are word-prefix anchored (\b) so "display" doesn't hit "pay" or "latest" hit "test".
// The same table auto-tags ingested items, so keep each pattern specific to its tags.
const INTENTS = [
  [/\b(brows|web ?pages?\b|click|chrome|forms?\b)/, ["browser", "web", "automation"]],
  [/\b(web search|search the (web|internet)|look (things|stuff|it) up|google (it|things|search)|internet search)\b/, ["search", "web-search"]],
  [/\b(websites?|web ?apps?|sites?)\b/, ["web"]],
  [/\b(screenshot|scrap|crawl)/, ["scraping", "screenshot"]],
  [/\b(docs\b|documentation|up.to.date|librar(y|ies)|frameworks?\b|api reference|outdated)/, ["docs", "documentation", "libraries"]],
  // Not "query"/"tables": they tagged search tools and docs as databases.
  [/\b(databases?|sql|mysql|sqlite)\b/, ["database", "sql"]],
  [/\bpostgre/, ["postgres", "database"]],
  [/\bgithub\b/, ["github"]],
  [/\b(pull requests?|prs?\b)/, ["pull-requests", "github"]],
  [/\b(issues?|tickets?)\b/, ["issues"]],
  [/\b(git|commits?|branch(es)?)\b/, ["git", "version-control"]],
  [/\b(test|tdd|qa\b|e2e)/, ["testing"]],
  [/\b(slides?|presentations?|decks?|powerpoint|pptx)\b/, ["pptx", "slides"]],
  [/\b(spreadsheets?|excel|xlsx|csv)\b/, ["xlsx", "spreadsheet"]],
  [/\bpdfs?\b/, ["pdf", "documents"]],
  [/\b(word doc|docx)/, ["docx", "documents"]],
  [/\b(remember|memor(y|ies)|forget)/, ["memory", "persistence"]],
  [/\bnotion\b/, ["notion", "notes"]],
  [/\b(notes?|wiki|knowledge base)\b/, ["notes", "wiki"]],
  [/\b(crash|errors?\b|exceptions?|bugs?\b|broken|stack ?traces?)/, ["errors", "debugging"]],
  [/\b(monitor|observability|logs?\b|alerts?\b)/, ["monitoring"]],
  [/\b(slow|performance|speed up|faster|lighthouse)/, ["performance"]],
  [/\b(payments?|pay\b|billing|stripe|invoices?|subscriptions?|checkout)/, ["payments", "billing"]],
  [/\b(deploy|hosting|host my|publish my site|serverless|vercel|netlify)/, ["deploy", "hosting"]],
  [/\b(cloudflare|workers\b)/, ["cloudflare", "deploy"]],
  [/\b(secur|vulnerab|owasp|secrets?\b|pentest)/, ["security"]],
  [/\b(code review|review (my|this|the) code|feedback on my code|reviewer)/, ["code-review"]],
  [/\b(design|figma|ui\b|ux\b|pretty|nicer|css|frontend|front-end)/, ["design", "frontend"]],
  [/\b(local (model|llm|ai)|offline|on my (laptop|computer|machine)|private ai|ollama)/, ["local-llm", "offline"]],
  [/\b(agents?\b|agentic|orchestrat|multi.?agent|autonomous)/, ["agents"]],
  [/\b(files?|folders?|director(y|ies))\b/, ["files", "filesystem"]],
  [/\b(plan|planning|think|reason|step by step|break down)/, ["planning", "reasoning"]],
  [/\b(explain|learn|teach|new to|beginner|understand)/, ["learning", "explain"]],
  [/\b(json|structured|schema|extract)/, ["json", "structured-output"]],
  [/\b(images?|pictures?|photos?|art\b|artwork|draw|illustrat)/, ["image", "art"]],
  [/\b(email|e-mail|gmail|inbox|outlook)\b/, ["email"]],
  [/\b(slack|discord|teams|chat app)\b/, ["messaging"]],
  [/\b(calendar|meetings?)\b/, ["calendar"]],
  [/\b(mobile|ios|android|flutter|react native)\b/, ["mobile"]],
  [/\b(blog|articles?|copywriting|essay|newsletter)\b/, ["writing", "content"]],
  [/\b(claude\.?md|agents\.?md|set ?up claude|configure claude|onboard)/, ["claude-md", "setup"]],
];

const TYPE_WORDS = [
  [/\bmcp|server|connector|integrat|connect to/, "mcp"],
  [/\bplugin/, "plugin"],
  [/\bskill/, "skill"],
  [/\brepo(sitor(y|ies))?\b|open source|github project/, "repo"],
  [/\bprompt/, "prompt"],
];

const FIELD_WEIGHTS = { name: 3, tags: 2.5, useCases: 2, summary: 1.5, description: 1, kind: 0.6 };

// Words people use for each item type, so "github repo for X" or "connector for Y" match by type too.
const KIND_WORDS = {
  skill: "skill agent skill",
  plugin: "plugin claude code plugin",
  mcp: "mcp server connector integration",
  repo: "github repo repository open source",
  prompt: "prompt template",
};
const K1 = 1.2;
const B = 0.75;

// The catalog repeats the same few thousand words; memoizing stems makes indexing ~3x faster.
const stemCache = new Map();

/** Deliberately light stemmer: "slides"/"slide" -> "slide", "tests"/"testing" -> "test". */
export function stem(word) {
  let w = stemCache.get(word);
  if (w !== undefined) return w;
  w = stemUncached(word);
  if (stemCache.size < 200_000) stemCache.set(word, w);
  return w;
}

function stemUncached(word) {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (/(ch|sh|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && /[^su]s$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  return w.replace(/([^aeiou])\1$/, "$1");
}

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

// ---------- Typo tolerance ----------

/** Optimal-string-alignment distance (edits incl. adjacent swaps), giving up past `max`. */
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// Only words common enough to be real vocabulary are offered as corrections.
const MIN_CORRECTION_DF = 3;

/** Nearest indexed word to a misspelled one ("databse" -> "database"), or null. */
function correctTerm(index, word) {
  const max = word.length >= 7 ? 2 : 1;
  if (!index.byInitial) {
    index.byInitial = new Map();
    for (const [term, df] of index.df) {
      if (df < MIN_CORRECTION_DF || term.length < 3 || /\d/.test(term)) continue;
      let list = index.byInitial.get(term[0]);
      if (!list) index.byInitial.set(term[0], (list = []));
      list.push(term);
    }
  }
  let best = null;
  let bestDist = max + 1;
  for (const term of index.byInitial.get(word[0]) ?? []) {
    const d = editDistance(word, term, Math.min(max, bestDist));
    if (d < bestDist || (d === bestDist && best && index.df.get(term) > index.df.get(best))) {
      best = term;
      bestDist = d;
    }
  }
  return bestDist <= max ? surfaceForm(index, best, word) : null;
}

/** The written form of a stem closest to what was typed ("postgress" -> "postgres", not "postgresql"). */
function surfaceForm(index, term, typed) {
  const counts = new Map();
  // Only docs containing the stem can contain its written forms.
  for (const n of (index.postings.get(term) ?? []).slice(0, 300)) {
    const { item } = index.docs[n];
    for (const word of `${item.name} ${item.summary} ${item.description} ${item.tags.join(" ")}`.toLowerCase().split(/[^a-z0-9+#]+/)) {
      if (word && stem(word) === term) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  let best = term;
  let bestKey = [Infinity, 0];
  for (const [word, n] of counts) {
    const d = editDistance(typed, word, 4);
    if (d < bestKey[0] || (d === bestKey[0] && n > bestKey[1])) [best, bestKey] = [word, [d, n]];
  }
  return best;
}

/** Rewrites words the catalog has never seen into their closest known spelling; null if nothing changed. */
export function correctQuery(index, query) {
  let changed = false;
  const fixed = String(query ?? "").replace(/[a-z]{4,}/gi, (word) => {
    const lower = word.toLowerCase();
    if (STOPWORDS.has(lower)) return word;
    // A word seen in one or two descriptions ("conect") is likelier a typo than a real term.
    const df = index.df.get(stem(lower)) ?? 0;
    if (df >= MIN_CORRECTION_DF) return word;
    const fix = correctTerm(index, lower);
    if (!fix) return word;
    // A known-but-rare word is only "fixed" one edit away ("conect"), never trimmed to a stem ("shorter" -> "short").
    const inflected = lower.startsWith(fix) && /^(er|est|ly|ed|ing|ness)$/.test(lower.slice(fix.length));
    if (df && ((index.df.get(stem(fix)) ?? 0) < df * 20 || editDistance(lower, fix, 1) > 1 || inflected)) return word;
    changed = true;
    return fix;
  });
  return changed ? fixed : null;
}

/** Turns a plain-English request into search terms, implied tags and an implied item type. */
const INTENT_TAGS = new Set(INTENTS.flatMap(([, tags]) => tags));

/**
 * Drops intent tags an older ingest derived from a whole description ("...click a form field" made an
 * e-signature skill #browser). A tag survives when the name or summary implies it, or a source tag
 * spells it out ("browser-automation"). Curated seed tags are kept as written.
 */
export function cleanAutoTags(items) {
  for (const item of items) {
    if (item.source === "seed" || item.curated || !item.tags?.length) continue;
    const implied = new Set(parseQuery(`${item.name.replace(/[-_/]/g, " ")} ${item.summary ?? ""}`).tags);
    const sourceTags = item.tags.filter((t) => !INTENT_TAGS.has(t));
    item.tags = item.tags.filter((t) => !INTENT_TAGS.has(t) || implied.has(t) || sourceTags.some((s) => s.includes(t)));
  }
  return items;
}

export function parseQuery(query) {
  // Agent names ("...for ChatGPT") become a filter, not search terms.
  const { agent: impliedAgent, rest: lower } = agentInQuery(query);
  const tags = new Set();
  for (const [re, intentTags] of INTENTS) if (re.test(lower)) intentTags.forEach((t) => tags.add(t));
  let impliedType = null;
  for (const [re, type] of TYPE_WORDS) {
    if (re.test(lower)) {
      impliedType = type;
      break;
    }
  }
  return { raw: query, terms: tokenize(lower), tags: [...tags], impliedType, impliedAgent };
}

function fieldText(item, field) {
  if (field === "kind") return KIND_WORDS[item.type] ?? "";
  const value = item[field];
  return Array.isArray(value) ? value.join(" ") : value ?? "";
}

const FIELDS = Object.entries(FIELD_WEIGHTS);

/**
 * Builds a BM25F-style index once per catalog load: one field-weighted term-frequency map per doc,
 * plus an inverted index (term/tag -> doc numbers) so a query only scores docs that can match.
 */
export function buildIndex(items) {
  const df = new Map();
  const postings = new Map();
  const tagPostings = new Map();
  let totalLen = 0;
  const docs = items.map((item, n) => {
    const tf = new Map();
    let len = 0;
    for (const [field, weight] of FIELDS) {
      for (const t of tokenize(fieldText(item, field))) {
        tf.set(t, (tf.get(t) ?? 0) + weight);
        len += weight;
      }
    }
    for (const t of tf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
      let list = postings.get(t);
      if (!list) postings.set(t, (list = []));
      list.push(n);
    }
    const tagSet = new Set(item.tags.map(stem));
    for (const t of tagSet) {
      let list = tagPostings.get(t);
      if (!list) tagPostings.set(t, (list = []));
      list.push(n);
    }
    totalLen += len;
    return { item, tf, len, tagSet };
  });
  return { docs, df, postings, tagPostings, avgLen: totalLen / Math.max(1, docs.length) || 1, n: docs.length };
}

function bm25(index, doc, term) {
  const f = doc.tf.get(term);
  if (!f) return 0;
  const df = index.df.get(term);
  const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
  return idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / index.avgLen)));
}

/** Doc numbers that contain at least one query term or intent tag; null means "every doc". */
function candidateDocs(index, terms, intentTags) {
  if (!terms.length && !intentTags.length) return null;
  const set = new Set();
  for (const t of terms) for (const n of index.postings.get(t) ?? []) set.add(n);
  for (const t of intentTags) for (const n of index.tagPostings.get(t) ?? []) set.add(n);
  return set;
}

const PHRASE_BONUS = 8;
const normalizePhrase = (text) => ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** True when the query contains one of the item's use-case phrases, or is one (3+ words, or exact). */
function phraseHit(item, query) {
  if (!item.useCases?.length) return false;
  const q = normalizePhrase(query);
  return item.useCases.some((uc) => {
    const p = normalizePhrase(uc);
    return q === p || (p.split(" ").length >= 5 && q.includes(p)); // 3+ words: the padding spaces count as 2
  });
}

// Results scoring under this share of the 5th-best match are dropped.
const RELEVANCE_CUTOFF = 0.5;

const LEVEL_RANK = { beginner: 0, intermediate: 1, expert: 2 };

/**
 * @param {object} index from buildIndex
 * @param {object} opts { q, type, agent, level, tags, limit, official: only first-party publishers, easy: beginner-level setup only }
 */
export function search(index, { q = "", type = null, agent = null, level = "beginner", tags = [], limit = 30, official = false, easy = false } = {}) {
  const corrected = correctQuery(index, q);
  const parsed = parseQuery(corrected ?? q);
  parsed.raw = q;
  parsed.corrected = corrected;
  const wantedType = type || null;
  const wantedAgent = agent || parsed.impliedAgent;
  const filterTags = tags.map((t) => stem(t.toLowerCase()));
  const intentTags = parsed.tags.map(stem);
  const hasQuery = parsed.terms.length > 0 || intentTags.length > 0;

  const results = [];
  const candidates = candidateDocs(index, parsed.terms, intentTags);
  for (const n of candidates ?? index.docs.keys()) {
    const doc = index.docs[n];
    const { item } = doc;
    if (wantedType && item.type !== wantedType) continue;
    if (wantedAgent && !item.agents.includes(wantedAgent)) continue;
    if (official && !item.official) continue;
    if (easy && item.level !== "beginner") continue;
    if (filterTags.length && !filterTags.every((t) => doc.tagSet.has(t))) continue;

    const matchedTerms = [];
    let text = 0;
    for (const term of parsed.terms) {
      const s = bm25(index, doc, term);
      if (s > 0) matchedTerms.push(term);
      text += s;
    }
    const matchedTags = intentTags.filter((t) => doc.tagSet.has(t));
    const intent = matchedTags.length * 2.2;
    if (hasQuery && text === 0 && intent === 0) continue;

    // Trust scales relevance (0.7x for unknown community listings, up to ~1.3x for official,
    // well-starred ones) so a strong text match from an unknown source can still win.
    const trust = (item.trust?.score ?? 40) / 100;
    const typeBoost = parsed.impliedType && item.type === parsed.impliedType ? 1.5 : 0;
    const levelFit = level === "beginner" ? -0.08 * LEVEL_RANK[item.level] : 0;
    // Matching every word of "unit tests in python" beats matching "tests" very strongly.
    const coverage = parsed.terms.length ? 0.35 + 0.65 * (matchedTerms.length / parsed.terms.length) : 1;
    // Curated use-case phrases ("make it shorter") are hand-written intents: a query that says one is a direct hit.
    const phrase = phraseHit(item, parsed.raw) ? PHRASE_BONUS : 0;
    const relevance = (text + intent) * coverage + typeBoost + phrase;
    // Hand-curated seed entries have reviewed copy and install steps; nudge them up.
    const curated = item.curated ? 1.25 : 1;
    // With a specific agent picked, things that install into it beat generic "works anywhere" repos.
    const genericRepo = wantedAgent && item.type === "repo" && item.genericAgents ? 0.7 : 1;
    // Gaining hundreds of stars a week is a real signal that people find it useful right now.
    const hot = item.trending?.weekly >= 500 ? 1.1 : 1;
    const score = hasQuery
      ? relevance * (0.4 + 0.9 * trust) * (1 + levelFit) * curated * genericRepo * hot
      : (trust * 10 + levelFit) * genericRepo;

    results.push({ item, score, matchedTerms, matchedTags });
  }
  results.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  diversifyNames(results, limit);
  // Long tails of one-word matches ("web" for "use a web browser") pad the count without helping.
  // Anchored on the 5th result, not the 1st, so one standout match can't wipe out the runners-up.
  const anchor = results[Math.min(4, results.length - 1)]?.score ?? 0;
  const kept = hasQuery ? results.filter((r) => r.score >= anchor * RELEVANCE_CUTOFF) : results;
  return {
    query: parsed,
    total: kept.length,
    results: kept.slice(0, limit).map((r) => ({
      ...r,
      why: explainMatch(r, parsed, level),
    })),
  };
}

/**
 * Many publishers ship a "slack" or "pdf" entry; a page of near-identical names hides the alternatives.
 * Each repeat of a name in the top results gets a growing penalty, then the top is re-sorted.
 */
function diversifyNames(results, limit) {
  const window = results.slice(0, limit * 3);
  const seen = new Map();
  for (const r of window) {
    // Per type: a "linear" skill and the Linear MCP server are different things worth showing together.
    const name = `${r.item.type}:${r.item.name.toLowerCase().replace(/^.*\//, "").replace(/[^a-z0-9]+/g, "").replace(/(mcp|server|skills?)+$/, "")}`;
    const count = seen.get(name) ?? 0;
    if (count) r.score *= 0.55 ** count;
    seen.set(name, count + 1);
  }
  window.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  results.splice(0, window.length, ...window);
}

const TYPE_LABEL = { skill: "skill", plugin: "plugin", mcp: "MCP server", repo: "GitHub repo", prompt: "prompt" };

/** Deterministic "why this matches" line; replaced by Claude's wording when AI ranking is on. */
export function explainMatch({ item, matchedTerms, matchedTags }, parsed, level) {
  const hits = [...new Set([...matchedTags, ...matchedTerms])].slice(0, 3);
  if (!parsed.terms.length && !parsed.tags.length) return item.summary;
  const label = TYPE_LABEL[item.type];
  if (level === "beginner") {
    const ease = item.level === "beginner" ? "Easy to set up." : item.requires?.length ? `You'll need: ${item.requires.join(", ")}.` : "";
    return `This ${label} matches "${hits.join(", ") || parsed.raw}". ${ease}`.trim();
  }
  const signals = [label, ...(item.requires ?? []).slice(0, 2), item.license].filter(Boolean).join(" · ");
  return `Matched ${hits.map((h) => `\`${h}\``).join(", ") || "query"} — ${signals}`;
}

export function topTags(items, n = 12) {
  const counts = new Map();
  for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([tag, count]) => ({ tag, count }));
}
