# AI Deck

Find skills, plugins, MCP servers, prompts and GitHub repos for **Claude Code, the Claude app, ChatGPT, Codex, Gemini CLI, the Gemini app, Cursor, GitHub Copilot, Windsurf and any other MCP app** (Cline, Zed, Goose, LM Studio...) by describing what you need in plain English ("let my AI use a web browser", "make slides from my notes"). Every item shows which agents it works with and how to install it in each one. The UI is built from the Stitch project *AI Developer Resource Hub Deck*.

## Run it locally

```bash
npm install
npm run ingest      # build data/catalog.json from live sources (optional: the seed works without it)
npm run build       # Tailwind CSS + copy search modules and catalog.json into public/
npm start           # http://127.0.0.1:5173
```

## Deploy (Cloudflare Workers)

```bash
npx wrangler login
npm run deploy      # build + wrangler deploy
```

`wrangler.jsonc` serves the site on `*.workers.dev` until the `aidecks.dev` domain is registered (then re-enable its `routes` line), and provisions a `SUBMISSIONS` KV namespace. To turn on AI ranking in production, add one key: `npx wrangler secret put OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`).

## How it works

- **Search runs in the browser.** `scripts/build-web.js` copies the runtime-neutral modules (`server/agents.js`, `catalog.js`, `search.js`, `api.js`) to `public/lib/` along with a compact `catalog.json` and a max-level brotli copy (`catalog.json.br`, ~1.2 MB for 15k items) that the Worker serves in its place. `index.html` preloads it alongside the scripts. Listings render from the catalog alone; the search index is built on the first search or when the browser is idle, then answers in milliseconds, so hosting is static-file cheap. On the search page, results follow the box as you type (AI ranking waits for Enter).
- **Icons** load from Google Fonts with `icon_names=` (about 8 KB instead of 1 MB). A new icon name in `app.js` or `index.html` has to be added to that list in `index.html`.
- **Ranking** (`server/search.js`): everyday phrases map to tags ("crashing" → errors), BM25F scores the text fields over an inverted index, and the result is scaled by a trust score built from objective signals only (official publisher, stars, last push, license, archived). Hand-curated seed entries get a small boost, and republished copies of the same skill are collapsed.
- **Agents** (`server/agents.js`): each MCP server's `claude mcp add` command is parsed into one spec, which generates the install for every agent: `codex mcp add`, `gemini mcp add`, `code --add-mcp`, Cursor's `mcp.json`, Claude Desktop config, and Windsurf's `mcp_config.json`, a generic `mcpServers` block for any other MCP app, and custom-connector steps for ChatGPT and claude.ai. Remote servers only for ChatGPT; the Gemini app takes prompts only. Skills follow the open Agent Skills (SKILL.md) format. Installs are generated lazily, when a card is shown.
- **AI ranking, optional** (`server/ai.js`, server-side only): the top 20 local matches go to Claude, OpenAI, Gemini or OpenRouter (whichever key is set; `AI_DECK_PROVIDER` picks one, `AI_DECK_MODEL` overrides its default model), which picks the best and explains each pick for the user's level and agent. Off without credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, or `ant auth login` locally).

## Data sources (`scripts/ingest.js`)

| Source | What it adds |
|---|---|
| `data/seed.json` | Curated items with beginner-friendly copy and install steps |
| Plugin marketplaces | `~/.claude/plugins/marketplaces/*` (incl. `claude-plugins-official`), else fetched from GitHub |
| Community marketplaces | `.claude-plugin/marketplace.json` from top `claude-code` / `claude-code-plugin` repos |
| Skills | `SKILL.md` from installed plugins, `anthropics/skills`, `openai/skills` and the top community skill repos |
| MCP Registry | Every server on `registry.modelcontextprotocol.io` with a generated install |
| GitHub topics | Top repos for MCP, Claude Code, Agent Skills, Codex, Gemini CLI (+ extensions), Cursor rules, Copilot, ChatGPT/GPTs, agents, prompts |
| GitHub API | Stars, forks, last push, license, language, archived (cached 24h) |

**Trending** (`npm run trending`, separate from ingest so it can run daily): `scripts/trending.js` reads `github.com/trending` (daily, weekly, monthly, and the main AI languages; GitHub has no API for it and `robots.txt` allows it), keeps AI repos, drops jailbreak tools, and adds new AI repos rising fast from GitHub search. It writes `data/trending.json`, which the build merges in like the seed: the Explore section, the `#/trending` page and a small ranking boost. Then `npm run deploy`.

GitHub limits are low when anonymous. Ingest uses `GITHUB_TOKEN`, or a signed-in `gh` CLI's token automatically, to pull far more (more topic pages, more skill repos, full stats). Options: `--offline`, `--max-mcp=N`, `--max-github=N`, `--topic-pages=N`, `--skill-repos=N`.

## Tests

```bash
npm test
```
