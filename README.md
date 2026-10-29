# AI Deck

Find Claude Code skills, plugins, MCP servers, prompts and GitHub repos by describing what you need in plain English ("let Claude use my web browser", "make slides from my notes"). The UI is built from the Stitch project *AI Developer Resource Hub Deck* (CyberDeck Console design system).

## Run it

```bash
npm install
npm run ingest      # build data/catalog.json from live sources (optional: the seed works without it)
npm run build:css
npm start           # http://127.0.0.1:5173
```

`npm run dev` rebuilds the CSS and restarts the server when files change. Run `npm run watch:css` alongside it while editing markup.

## How search works

1. **Local ranking, always on** (`server/search.js`): everyday phrases are mapped to catalog tags ("crashing" → errors, debugging), then BM25 scores the name, tags, use cases and description. That relevance is scaled by a trust score built from objective signals only: official publisher, stars, last push, license, archived.
2. **Claude ranking, optional** (`server/ai.js`): the top 20 local results go to `claude-opus-5-5` at low effort. Claude picks the best ones and writes a short "why this fits" for each, pitched at the user's level (New / Expert). It can also ask a clarifying question. Catalog text is passed as untrusted data, and only candidate ids can come back. The UI shows local results immediately and swaps in Claude's picks when they arrive.

   Turn it on with `ANTHROPIC_API_KEY` (or `ant auth login`). Override the model with `AI_DECK_MODEL`, or turn it off with `AI_DECK_DISABLE_AI=1`. Without credentials the app runs fully on local ranking.

## Data sources (`scripts/ingest.js`)

| Source | What it adds |
|---|---|
| `data/seed.json` | Curated items with beginner-friendly copy, use cases and install steps |
| Plugin marketplaces | Every plugin in `~/.claude/plugins/marketplaces/*` (incl. `claude-plugins-official`); falls back to fetching from GitHub |
| Installed plugin skills | `SKILL.md` frontmatter from `~/.claude/plugins/cache` |
| MCP Registry | `registry.modelcontextprotocol.io`, with `claude mcp add` commands generated from remotes/packages |
| GitHub API | Stars, forks, last push, license, language, archived (cached 24h in `data/github-cache.json`) |

Options: `--offline`, `--max-mcp=N`, `--max-github=N`. Set `GITHUB_TOKEN` to go beyond the anonymous limit of 60 GitHub requests per hour. The server reloads `catalog.json` automatically after an ingest.

Submissions from the **+ Submit** button go to `data/submissions.json` for review. They are not auto-published.

## Tests

```bash
npm test
```

Includes golden plain-English queries that must rank the right item in the top 3, plus parser tests for the ingest pipeline.
