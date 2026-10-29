// Local (no-LLM) search: plain-English intent expansion + BM25 over weighted fields.
// This always runs; the Claude reranker in ai.js only reorders and annotates its output.

const STOPWORDS = new Set(
  ("a an and are as at be but by can claude could do does for from get give help how i in into is it its " +
    "me my need of on or please some something that the this to tool tools use want way what when which " +
    "with would you your let lets make able thing things find any").split(" "),
);

// Everyday phrases -> catalog vocabulary. Keys are regexes over the raw query.
// Patterns are word-prefix anchored (\b) so "display" doesn't hit "pay" or "latest" hit "test".
// The same table auto-tags ingested items, so keep each pattern specific to its tags.
const INTENTS = [
  [/\b(brows|web ?pages?\b|click|chrome|forms?\b)/, ["browser", "web", "automation"]],
  [/\b(websites?|web ?apps?|sites?)\b/, ["web"]],
  [/\b(screenshot|scrap|crawl)/, ["scraping", "screenshot"]],
  [/\b(docs\b|documentation|up.to.date|librar(y|ies)|frameworks?\b|api reference|outdated)/, ["docs", "documentation", "libraries"]],
  [/\b(databases?|sql|mysql|sqlite|tables?\b|queries|query)\b/, ["database", "sql"]],
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
  [/\b(claude\.?md|set ?up claude|configure claude|onboard)/, ["claude-md", "setup"]],
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

/** Deliberately light stemmer: "slides"/"slide" -> "slide", "tests"/"testing" -> "test". */
export function stem(word) {
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

/** Turns a plain-English request into search terms, implied tags and an implied item type. */
export function parseQuery(query) {
  const lower = String(query ?? "").toLowerCase();
  const tags = new Set();
  for (const [re, intentTags] of INTENTS) if (re.test(lower)) intentTags.forEach((t) => tags.add(t));
  let impliedType = null;
  for (const [re, type] of TYPE_WORDS) {
    if (re.test(lower)) {
      impliedType = type;
      break;
    }
  }
  return { raw: query, terms: tokenize(query), tags: [...tags], impliedType };
}

function fieldText(item, field) {
  if (field === "kind") return KIND_WORDS[item.type] ?? "";
  const value = item[field];
  return Array.isArray(value) ? value.join(" ") : value ?? "";
}

/** Builds the per-field BM25 index once per catalog load. */
export function buildIndex(items) {
  const docs = items.map((item) => {
    const fields = {};
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      const tokens = tokenize(fieldText(item, field));
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      fields[field] = { tf, len: tokens.length };
    }
    return { item, fields, tagSet: new Set(item.tags.map(stem)) };
  });
  const df = new Map();
  const avgLen = {};
  for (const field of Object.keys(FIELD_WEIGHTS)) {
    let total = 0;
    for (const doc of docs) total += doc.fields[field].len;
    avgLen[field] = total / Math.max(1, docs.length) || 1;
  }
  for (const doc of docs) {
    const seen = new Set();
    for (const field of Object.keys(FIELD_WEIGHTS)) for (const t of doc.fields[field].tf.keys()) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { docs, df, avgLen, n: docs.length };
}

function bm25(index, doc, term) {
  const df = index.df.get(term);
  if (!df) return 0;
  const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
  let score = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const { tf, len } = doc.fields[field];
    const f = tf.get(term);
    if (!f) continue;
    score += weight * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / index.avgLen[field])));
  }
  return score;
}

const LEVEL_RANK = { beginner: 0, intermediate: 1, expert: 2 };

/**
 * @param {object} index from buildIndex
 * @param {object} opts { q, type, level: 'beginner'|'expert', tags: string[], limit }
 */
export function search(index, { q = "", type = null, level = "beginner", tags = [], limit = 30 } = {}) {
  const parsed = parseQuery(q);
  const wantedType = type || null;
  const filterTags = tags.map((t) => stem(t.toLowerCase()));
  const intentTags = parsed.tags.map(stem);
  const hasQuery = parsed.terms.length > 0 || intentTags.length > 0;

  const results = [];
  for (const doc of index.docs) {
    const { item } = doc;
    if (wantedType && item.type !== wantedType) continue;
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
    const relevance = text + intent + typeBoost;
    const score = hasQuery ? relevance * (0.4 + 0.9 * trust) * (1 + levelFit) : trust * 10 + levelFit;

    results.push({ item, score, matchedTerms, matchedTags });
  }
  results.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return {
    query: parsed,
    total: results.length,
    results: results.slice(0, limit).map((r) => ({
      ...r,
      why: explainMatch(r, parsed, level),
    })),
  };
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
