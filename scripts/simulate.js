#!/usr/bin/env node
// Simulated users: personas from beginner to expert, on different agents, run plain-English searches
// through the real API (same code path as the browser) and the results are graded automatically.
// Each query names what a satisfied user expects to see; the report shows where the deck lets them down.
//
//   node scripts/simulate.js            full report
//   node scripts/simulate.js --json     machine-readable summary
//   node scripts/simulate.js --fail     only the failing sessions
import { loadCatalog } from "../server/load.js";
import { buildIndex } from "../server/search.js";
import { createApi } from "../server/api.js";
import { AGENT_IDS } from "../server/agents.js";

// [query, regex a relevant result's name/summary/tags must match, options]
// `want` is graded on the top 5; `type` means a user who said "mcp"/"skill"/... expects that type on top.
const PERSONAS = [
  {
    name: "Maya, never coded, uses the ChatGPT app",
    level: "beginner",
    agent: "chatgpt",
    queries: [
      ["help me write emails faster", /email|gmail|inbox|outlook|writ/],
      ["make chatgpt read my google drive", /drive|google|docs/],
      ["connect to my calendar", /calendar|schedul/],
      ["summarize youtube videos", /youtube|video|transcript/],
      ["plan a trip", /travel|trip|flight|hotel|map/],
      ["look things up on the web", /search|web|brows/],
      ["what is mcp", /mcp|model context protocol/],
      ["make a logo", /image|logo|design|art/],
    ],
  },
  {
    name: "Sam, beginner, Claude desktop app",
    level: "beginner",
    agent: "claude",
    queries: [
      ["let claude read files on my computer", /file|filesystem|folder/],
      ["make slides from my notes", /slide|pptx|presentation/],
      ["claude should remember things about me", /memory|remember|persist/],
      ["read pdf files", /pdf/],
      ["connect claude to notion", /notion/],
      ["write better prompts", /prompt/],
      ["turn a spreadsheet into charts", /spreadsheet|xlsx|excel|chart|csv/],
      ["search my gmail", /gmail|email|inbox/],
    ],
  },
  {
    name: "Leo, student, Gemini app",
    level: "beginner",
    agent: "gemini-app",
    queries: [
      ["help me study for exams", /study|learn|explain|tutor|quiz|flashcard/],
      ["explain code like im five", /explain/],
      ["prompt for writing an essay", /writ|essay/],
    ],
  },
  {
    name: "Priya, web developer, Claude Code",
    level: "beginner",
    agent: "claude-code",
    queries: [
      ["let claude use my web browser", /brows|playwright|chrome|puppeteer/],
      ["test my website automatically", /test|playwright|e2e|qa/],
      ["up to date docs for react", /doc|context7|librar|react/],
      ["why does my app keep crashing", /error|crash|sentry|debug|bug/],
      ["review my pull requests", /review|pull.request|github|pr\b/],
      ["deploy my site", /deploy|host|vercel|netlify|cloudflare/],
      ["make my ui look nicer", /design|ui|frontend|css|tailwind/],
      ["connect to my postgres database", /postgres|database|sql/],
      ["git commit messages", /commit|git/],
      ["figma designs to code", /figma|design/],
      ["make my site faster", /perf|lighthouse|speed|fast/],
      ["accessibility checks", /a11y|accessib|wcag/],
      ["write unit tests for me", /test|tdd/],
      ["plugin for code review", /review/, { type: "plugin" }],
      ["skills for frontend design", /design|frontend|ui/, { type: "skill" }],
    ],
  },
  {
    name: "Dan, backend dev, Cursor",
    level: "expert",
    agent: "cursor",
    queries: [
      ["mcp server for postgres", /postgres/, { type: "mcp" }],
      ["redis", /redis/],
      ["kubernetes cluster management", /kubernetes|k8s|kubectl/],
      ["aws", /aws|amazon/],
      ["docker containers", /docker|container/],
      ["cursor rules for python", /python|rule/],
      ["stripe payments", /stripe|payment/],
      ["sentry errors", /sentry|error/],
      ["jira tickets", /jira|ticket|issue/],
      ["linear issues", /linear/],
      ["mongodb", /mongo/],
      ["graphql api", /graphql/],
      ["terraform", /terraform|infra/],
      ["openapi spec to mcp", /openapi|swagger|api/],
    ],
  },
  {
    name: "Ana, data analyst, Claude Code",
    level: "beginner",
    agent: "claude-code",
    queries: [
      ["analyze a csv file", /csv|data|spreadsheet|xlsx|pandas/],
      ["query bigquery", /bigquery|google cloud|sql/],
      ["snowflake", /snowflake/],
      ["make charts from data", /chart|plot|visual|graph|data/],
      ["jupyter notebooks", /jupyter|notebook/],
      ["excel", /excel|xlsx|spreadsheet/],
    ],
  },
  {
    name: "Kai, expert, Codex CLI",
    level: "expert",
    agent: "codex",
    queries: [
      ["agents.md template", /agents\.?md|claude\.?md|instruction/],
      ["skills for codex", /skill/, { type: "skill" }],
      ["mcp for github", /github/, { type: "mcp" }],
      ["sandboxed code execution", /sandbox|execut|code interpreter|e2b/],
      ["web search mcp", /search/, { type: "mcp" }],
      ["memory graph", /memory|graph|knowledge/],
      ["security audit my code", /secur|vulnerab|audit|scan/],
    ],
  },
  {
    name: "Ravi, expert, Gemini CLI",
    level: "expert",
    agent: "gemini",
    queries: [
      ["gemini cli extensions", /extension|gemini/],
      ["google workspace", /google|workspace|gmail|drive|docs/],
      ["firebase", /firebase/],
      ["cloud run deploy", /cloud run|deploy|gcp|google cloud/],
      ["slack bot", /slack/],
    ],
  },
  {
    name: "Jo, Copilot in VS Code",
    level: "beginner",
    agent: "copilot",
    queries: [
      ["copilot instructions", /copilot|instruction/],
      ["azure", /azure|microsoft/],
      ["playwright", /playwright/],
      ["browser automation", /brows|playwright|puppeteer|chrome/],
    ],
  },
  {
    name: "Wes, Windsurf user",
    level: "beginner",
    agent: "windsurf",
    queries: [
      ["supabase", /supabase/],
      ["figma", /figma/],
      ["documentation lookup", /doc/],
    ],
  },
  {
    name: "Ivy, ML researcher, any agent",
    level: "expert",
    agent: null,
    queries: [
      ["run ai models offline on my laptop", /ollama|local|offline|llama/],
      ["hugging face models", /hugging ?face|hf\b|model/],
      ["arxiv papers", /arxiv|paper|research/],
      ["vector database", /vector|embedding|pinecone|qdrant|weaviate|chroma/],
      ["rag pipeline", /rag\b|retriev/],
      ["fine tune a model", /fine.?tun|train/],
      ["agent framework", /agent/, { type: "repo" }],
      ["langchain", /langchain|langgraph/],
      ["multi agent orchestration", /agent|orchestr/],
    ],
  },
  {
    name: "Tom, founder, no agent picked",
    level: "beginner",
    agent: null,
    queries: [
      ["accept payments", /stripe|payment|billing/],
      ["send marketing emails", /email|newsletter|resend|mailchimp|marketing/],
      ["seo for my website", /seo|search engine/],
      ["social media posts", /social|twitter|x\.com|linkedin|post/],
      ["customer support chatbot", /support|chat|helpdesk|zendesk|intercom/],
      ["shopify store", /shopify|ecommerce|store/],
      ["hubspot crm", /hubspot|crm/],
      ["write a business plan", /business|plan|startup/],
      ["track analytics", /analytic|metric|posthog|google analytics/],
    ],
  },
  {
    name: "Typos and odd phrasing",
    level: "beginner",
    agent: null,
    queries: [
      ["brwoser automation", /brows|playwright|chrome|puppeteer/],
      ["databse", /database|sql/],
      ["claude code plugins", /./, { type: "plugin" }],
      ["MCP", /mcp|./, { type: "mcp" }],
      ["Skills", /./, { type: "skill" }],
      ["best mcp servers", /./, { type: "mcp" }],
      ["awesome lists", /awesome/],
      ["I want my AI to be able to look at my screen and click buttons", /computer.use|screen|click|brows|automat/],
      ["how do i get started", /start|begin|guide|tutorial|learn|setup/],
      ["something for youtube", /youtube/],
      ["spotify", /spotify|music/],
      ["home assistant smart home", /home.?assistant|smart home|iot/],
      ["obsidian notes", /obsidian/],
      ["discord", /discord/],
      ["whatsapp", /whatsapp/],
      ["telegram bot", /telegram/],
      ["blender 3d", /blender|3d/],
      ["unity game", /unity|game/],
      ["roblox", /roblox/],
      ["excel", /excel|xlsx|spreadsheet/],
      ["word documents", /docx|word/],
      ["translate text", /translat|language/],
      ["text to speech", /speech|tts|voice|audio/],
      ["transcribe audio", /transcri|whisper|speech|audio/],
      ["generate images", /image|art|stable diffusion|dall|flux|midjourney/],
    ],
  },
];

const CHAT_APPS = ["chatgpt", "claude", "gemini-app"];
const BAD_NAME = /^(server|mcp|mcp-server|app|main|src|index|test|demo|example|untitled|[0-9a-f-]{16,})$/i;
const textOf = (item) => `${item.name} ${item.summary} ${item.description} ${(item.tags ?? []).join(" ")}`.toLowerCase();

async function main() {
  const args = new Set(process.argv.slice(2));
  const t0 = performance.now();
  const catalog = loadCatalog();
  const index = buildIndex(catalog.items);
  const loadMs = performance.now() - t0;
  const handle = createApi({
    state: () => ({ catalog, index }),
    rerank: async () => null,
    aiStatus: () => ({ enabled: false }),
    saveSubmission: async () => ({ duplicate: false }),
  });
  const get = async (path) => {
    const [status, body] = await handle("GET", new URL(path, "http://sim"), async () => "");
    if (status !== 200) throw new Error(`${path} -> ${status}`);
    return body;
  };

  const sessions = [];
  for (const persona of PERSONAS) {
    for (const [q, want, opts = {}] of persona.queries) {
      const params = new URLSearchParams({ q, level: persona.level, limit: "10" });
      if (persona.agent) params.set("agent", persona.agent);
      const start = performance.now();
      const body = await get(`/api/search?${params}`);
      const ms = performance.now() - start;
      const top = body.results.map((r) => r.item);
      const top5 = top.slice(0, 5);
      const relevant = top5.filter((i) => want.test(textOf(i)));
      const problems = [];
      if (!body.total) problems.push("zero results");
      else {
        if (!want.test(textOf(top[0]))) problems.push("top result off-topic");
        if (relevant.length < Math.min(3, top5.length)) problems.push(`only ${relevant.length}/5 relevant`);
      }
      if (opts.type && top[0] && top[0].type !== opts.type) problems.push(`asked for ${opts.type}, top is ${top[0].type}`);
      const agent = persona.agent ?? body.intent.impliedAgent;
      for (const item of top5) {
        // Repo cards link to GitHub instead of an install panel, but chat apps can't run a repo at all.
        if (agent && item.type !== "repo" && !item.installs?.[agent]) problems.push(`no ${agent} install: ${item.id}`);
        if (item.type === "repo" && CHAT_APPS.includes(agent) && !item.tags.some((t) => t === "prompts" || t === agent)) problems.push(`repo shown to ${agent} user: ${item.id}`);
        if (BAD_NAME.test(item.name)) problems.push(`vague name: ${item.id}`);
        if (!item.summary?.trim()) problems.push(`no summary: ${item.id}`);
        if (item.archived) problems.push(`archived in top 5: ${item.id}`);
        if (persona.level === "beginner" && item.level === "expert" && item === top[0]) problems.push(`expert item first for beginner: ${item.id}`);
      }
      const names = top.map((i) => `${i.type}:${i.name.toLowerCase()}`); // a skill and a server may share a name
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length) problems.push(`duplicate names in top 10: ${[...new Set(dupes)].join(", ")}`);
      if (ms > 50) problems.push(`slow: ${ms.toFixed(0)}ms`);
      sessions.push({ persona: persona.name, agent: persona.agent, level: persona.level, q, total: body.total, ms, top: top.slice(0, 5).map((i) => `${i.id} (${i.type}, trust ${i.trust.score})`), relevant: relevant.length, problems });
    }
  }

  // Browsing: every agent's "Explore"-style listing should be non-empty and its installs present.
  const browse = [];
  for (const agent of AGENT_IDS) {
    for (const type of ["skill", "plugin", "mcp", "repo", "prompt"]) {
      const body = await get(`/api/items?type=${type}&agent=${agent}&limit=12`);
      const missing = type === "repo" ? 0 : body.items.filter((i) => !i.installs?.[agent]).length;
      browse.push({ agent, type, total: body.total, missing, first: body.items.slice(0, 3).map((i) => i.id) });
    }
  }

  const failing = sessions.filter((s) => s.problems.length);
  const counts = {};
  for (const s of sessions) for (const p of s.problems) {
    const key = p.replace(/:.*$/, "").replace(/\d+\/5/, "N/5").replace(/\d+ms/, "Nms");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const summary = {
    catalogItems: catalog.items.length,
    indexMs: Math.round(loadMs),
    sessions: sessions.length,
    satisfied: sessions.length - failing.length,
    precisionAt5: +(sessions.reduce((a, s) => a + (s.total ? s.relevant / Math.min(5, s.total) : 0), 0) / sessions.length).toFixed(3),
    p95Ms: +sessions.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(sessions.length * 0.95)].toFixed(1),
    problemCounts: counts,
    emptyBrowse: browse.filter((b) => b.total === 0).map((b) => `${b.agent}/${b.type}`),
    browseMissingInstalls: browse.filter((b) => b.missing).map((b) => `${b.agent}/${b.type}`),
  };

  if (args.has("--json")) return console.log(JSON.stringify({ summary, sessions: failing }, null, 2));
  for (const s of args.has("--fail") ? failing : sessions) {
    console.log(`\n[${s.problems.length ? "FAIL" : " ok "}] ${s.persona} | "${s.q}" | ${s.total} results, ${s.relevant}/5 relevant`);
    for (const line of s.top) console.log(`        ${line}`);
    for (const p of s.problems) console.log(`   !! ${p}`);
  }
  console.log("\n", summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
