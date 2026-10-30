// Runtime-neutral API routes, shared by the Node server (server/index.js) and the Worker (worker/index.js).
import { catalogStats, TYPES } from "./catalog.js";
import { search, topTags } from "./search.js";
import { AGENTS, AGENT_IDS } from "./agents.js";

const parseLevel = (value) => (value === "expert" ? "expert" : "beginner");
const parseType = (value) => (TYPES.includes(value) ? value : null);
const parseAgent = (value) => (AGENT_IDS.includes(value) ? value : null);

/**
 * @param {object} ctx
 * @param {() => {catalog, index}} ctx.state current catalog and search index
 * @param {(q, level, agent, items) => Promise<object|null>} ctx.rerank
 * @param {() => object} ctx.aiStatus
 * @param {(entry) => Promise<{duplicate: boolean}>} ctx.saveSubmission
 * @returns {(method: string, url: URL, readBody: () => Promise<string>) => Promise<[number, object]>}
 */
export function createApi({ state, rerank, aiStatus, saveSubmission }) {
  const routes = {
    "GET /api/ai": () => aiStatus(),

    "GET /api/stats": () => {
      const { catalog } = state();
      return { ...catalogStats(catalog), agents: AGENTS, ai: aiStatus() };
    },

    "GET /api/search": (url) => {
      const { index } = state();
      const q = (url.searchParams.get("q") ?? "").slice(0, 300);
      const { results, total, query } = search(index, {
        q,
        type: parseType(url.searchParams.get("type")),
        agent: parseAgent(url.searchParams.get("agent")),
        level: parseLevel(url.searchParams.get("level")),
        tags: url.searchParams.getAll("tag").filter(Boolean),
        limit: Math.min(300, Number(url.searchParams.get("limit")) || 30),
        official: url.searchParams.get("official") === "1",
        easy: url.searchParams.get("easy") === "1",
      });
      return {
        total,
        intent: { tags: query.tags, impliedType: query.impliedType, impliedAgent: query.impliedAgent, corrected: query.corrected },
        results: results.map((r) => ({ item: r.item, why: r.why, score: Number(r.score.toFixed(3)) })),
      };
    },

    // Second phase of a search: the client calls this after rendering local results.
    "GET /api/rank": async (url) => {
      if (!aiStatus().enabled) return { ai: false, ...aiStatus() };
      const { catalog, index } = state();
      const q = (url.searchParams.get("q") ?? "").slice(0, 300);
      const level = parseLevel(url.searchParams.get("level"));
      const agent = parseAgent(url.searchParams.get("agent"));
      const { results } = search(index, {
        q,
        type: parseType(url.searchParams.get("type")),
        agent,
        level,
        limit: 20,
        official: url.searchParams.get("official") === "1",
        easy: url.searchParams.get("easy") === "1",
      });
      const ranked = await rerank(q, level, agent, results.map((r) => r.item));
      if (!ranked) return { ai: false, ...aiStatus() };
      return {
        ai: true,
        model: ranked.model,
        provider: ranked.provider,
        clarify: ranked.clarify,
        results: ranked.picks.map((p) => ({ item: catalog.byId.get(p.id), why: p.why })),
      };
    },

    "GET /api/items": (url) => {
      const { catalog } = state();
      const type = parseType(url.searchParams.get("type"));
      const types = url.searchParams.getAll("types").filter((t) => TYPES.includes(t));
      const agent = parseAgent(url.searchParams.get("agent"));
      const tag = url.searchParams.get("tag");
      const language = url.searchParams.get("language");
      const category = url.searchParams.get("category");
      const ids = url.searchParams.get("ids");
      const sort = url.searchParams.get("sort") ?? "trust";
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(100, Number(url.searchParams.get("limit")) || 40);

      let items = catalog.items;
      if (ids) items = ids.split(",").slice(0, 200).map((id) => catalog.byId.get(id)).filter(Boolean);
      if (type) items = items.filter((i) => i.type === type);
      if (types.length) items = items.filter((i) => types.includes(i.type));
      if (agent) items = items.filter((i) => i.agents.includes(agent));
      if (tag) items = items.filter((i) => i.tags.includes(tag.toLowerCase()));
      if (language) items = items.filter((i) => i.language === language);
      if (category) items = items.filter((i) => i.category === category);
      if (url.searchParams.get("official") === "1") items = items.filter((i) => i.official);
      if (url.searchParams.get("easy") === "1") items = items.filter((i) => i.level === "beginner");
      // Connectors: remote MCP servers, added to the Claude app or ChatGPT by URL (ChatGPT takes no others).
      if (url.searchParams.get("remote") === "1") items = items.filter((i) => i.type === "mcp" && i.agents.includes("chatgpt"));

      const sorters = {
        trust: (a, b) => b.trust.score - a.trust.score || (b.stars ?? 0) - (a.stars ?? 0),
        stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
        updated: (a, b) => Date.parse(b.pushedAt ?? 0) - Date.parse(a.pushedAt ?? 0),
        name: (a, b) => a.name.localeCompare(b.name),
        // Exact weekly gains from GitHub's page first; estimates for brand-new repos after.
        trending: (a, b) => Number(a.trending.estimated) - Number(b.trending.estimated) || b.trending.weekly - a.trending.weekly,
      };
      if (sort === "trending") {
        // One entry per repo: a trending repo's plugin and its skills would otherwise fill the list.
        // Keep the card that stands for the whole repo: the repo itself, else its plugin or server.
        const typeRank = { repo: 0, plugin: 1, mcp: 2, skill: 3, prompt: 4 };
        const seen = new Set();
        items = items
          .filter((i) => i.trending)
          .sort((a, b) => typeRank[a.type] - typeRank[b.type])
          .filter((i) => !seen.has(i.repo.toLowerCase()) && seen.add(i.repo.toLowerCase()));
      }
      if (!ids) items = [...items].sort(sorters[sort] ?? sorters.trust);

      const pool = type || types.length ? items : catalog.items;
      return {
        total: items.length,
        items: items.slice(offset, offset + limit),
        tags: topTags(pool, 14),
        languages: [...new Set(pool.map((i) => i.language).filter(Boolean))].sort(),
      };
    },

    "POST /api/submit": async (_url, readBody) => {
      let payload;
      try {
        payload = JSON.parse(await readBody());
      } catch {
        return [400, { error: "Expected a JSON body" }];
      }
      const link = String(payload.url ?? "").trim();
      if (!/^https:\/\/[\w.-]+\/\S+$/.test(link) || link.length > 400) {
        return [400, { error: "Enter an https:// link to a repo or manifest" }];
      }
      const entry = {
        url: link,
        category: TYPES.includes(payload.category) ? payload.category : "skill",
        note: String(payload.note ?? "").slice(0, 500),
        submittedAt: new Date().toISOString(),
      };
      const { duplicate } = await saveSubmission(entry);
      return { ok: true, duplicate };
    },
  };

  return async function handleApi(method, url, readBody) {
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return [404, { error: "Not found" }];
    try {
      const result = await route(url, readBody);
      return Array.isArray(result) ? result : [200, result];
    } catch (error) {
      console.error(`[api] ${method} ${url.pathname} failed:`, error);
      return [500, { error: "Internal error" }];
    }
  };
}
