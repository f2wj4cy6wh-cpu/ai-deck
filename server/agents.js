// Which AI agents an item works with, and how to install it in each one.
// MCP installs are generated from one structured spec, parsed from the item's `claude mcp add` command.

export const AGENTS = [
  { id: "claude-code", label: "Claude Code", short: "Claude Code" },
  { id: "claude", label: "Claude app (claude.ai / Desktop)", short: "Claude" },
  { id: "chatgpt", label: "ChatGPT", short: "ChatGPT" },
  { id: "codex", label: "OpenAI Codex CLI", short: "Codex" },
  { id: "gemini", label: "Gemini CLI", short: "Gemini CLI" },
  { id: "gemini-app", label: "Gemini app (gemini.google.com)", short: "Gemini" },
  { id: "cursor", label: "Cursor", short: "Cursor" },
  { id: "copilot", label: "GitHub Copilot (VS Code)", short: "Copilot" },
  { id: "windsurf", label: "Windsurf", short: "Windsurf" },
  { id: "other", label: "Any other MCP app or agent (Cline, Zed, Goose, LM Studio...)", short: "Other" },
];
export const AGENT_IDS = AGENTS.map((a) => a.id);

/** Splits a shell-ish command line, honoring double quotes. */
function shellSplit(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

/**
 * Parses `claude mcp add [--transport t] [--header "K: V"] [-e K=V] name (url | -- cmd args...)`.
 * @returns {{name, transport, url?, command?, args?, headers, env} | null}
 */
export function parseClaudeMcpAdd(command) {
  if (!command?.startsWith("claude mcp add ")) return null;
  const tokens = shellSplit(command.slice("claude mcp add ".length));
  const spec = { transport: "stdio", headers: {}, env: {} };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      spec.command = tokens[i + 1];
      spec.args = tokens.slice(i + 2);
      break;
    }
    if (t === "--transport" || t === "-t") spec.transport = tokens[++i];
    else if (t === "--header" || t === "-H") {
      const [k, ...v] = tokens[++i].split(":");
      spec.headers[k.trim()] = v.join(":").trim();
    } else if (t === "-e" || t === "--env") {
      const [k, ...v] = tokens[++i].split("=");
      spec.env[k] = v.join("=");
    } else if (t === "--scope" || t === "-s") i++;
    else positional.push(t);
  }
  spec.name = positional[0];
  if (spec.transport !== "stdio") spec.url = positional[1];
  else if (!spec.command && positional.length > 1) {
    // `claude mcp add name cmd args` without `--`
    spec.command = positional[1];
    spec.args = positional.slice(2);
  }
  return spec.name && (spec.url || spec.command) ? spec : null;
}

const json = (value) => JSON.stringify(value, null, 2);
const quoteArg = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function serverEntry(spec, { typeKey = null } = {}) {
  if (spec.transport === "stdio") {
    const entry = { command: spec.command, args: spec.args ?? [] };
    if (Object.keys(spec.env).length) entry.env = spec.env;
    return entry;
  }
  const entry = { url: spec.url };
  if (typeKey) entry[typeKey] = spec.transport === "sse" ? "sse" : "http";
  if (Object.keys(spec.headers).length) entry.headers = spec.headers;
  return entry;
}

/** The URL a remote MCP server is added by in the Claude app or ChatGPT (a "connector"); null if it runs locally. */
export function connectorUrl(item) {
  if (item.type !== "mcp") return null;
  const spec = parseClaudeMcpAdd(item.install?.command);
  return spec && spec.transport !== "stdio" ? spec.url : null;
}

/** Per-agent install instructions for an MCP server. */
export function mcpInstalls(spec, claudeCommand) {
  const remote = spec.transport !== "stdio";
  const needsHeaders = Object.keys(spec.headers).length > 0;
  const installs = { "claude-code": { kind: "command", where: "terminal", value: claudeCommand } };

  installs.claude = remote
    ? { kind: "steps", value: ["In Claude, open Settings → Connectors → Add custom connector", `Paste this URL: ${spec.url}`, ...(needsHeaders ? ["This server expects an auth header; if Claude can't sign in, use Claude Code instead"] : [])] }
    : {
        kind: "config",
        where: "claude_desktop_config.json (Claude Desktop only)",
        value: json({ mcpServers: { [spec.name]: serverEntry(spec) } }),
        note: "Open it from Claude Desktop: Settings → Developer → Edit Config. It lives in ~/Library/Application Support/Claude/ on Mac and %APPDATA%\\Claude\\ on Windows. If it already has an mcpServers block, add this entry inside it.",
      };

  if (remote) {
    installs.chatgpt = {
      kind: "steps",
      value: [
        "In ChatGPT, open Settings → Apps & Connectors → Advanced settings and turn on Developer mode",
        "Back in Apps & Connectors, choose Create and give it a name",
        `Paste this MCP server URL: ${spec.url}`,
        ...(needsHeaders ? ["This server uses a token header; ChatGPT only supports OAuth or no auth, so it may not connect"] : []),
      ],
    };
  }

  installs.codex = {
    kind: "command",
    where: "terminal",
    value: remote ? `codex mcp add ${spec.name} --url ${spec.url}` : `codex mcp add ${spec.name} -- ${[spec.command, ...(spec.args ?? [])].map(quoteArg).join(" ")}`,
  };
  installs.gemini = {
    kind: "command",
    where: "terminal",
    value: remote
      ? `gemini mcp add --transport ${spec.transport === "sse" ? "sse" : "http"} ${spec.name} ${spec.url}`
      : `gemini mcp add ${spec.name} ${[spec.command, ...(spec.args ?? [])].map(quoteArg).join(" ")}`,
  };
  installs.cursor = { kind: "config", where: "~/.cursor/mcp.json", value: json({ mcpServers: { [spec.name]: serverEntry(spec) } }) };
  // Windsurf names the remote field serverUrl; everything else reads the common mcpServers shape.
  const windsurfEntry = remote ? { serverUrl: spec.url, ...(needsHeaders ? { headers: spec.headers } : {}) } : serverEntry(spec);
  installs.windsurf = { kind: "config", where: "~/.codeium/windsurf/mcp_config.json", value: json({ mcpServers: { [spec.name]: windsurfEntry } }) };
  installs.other = {
    kind: "config",
    where: "your app's MCP settings (most apps accept this mcpServers format)",
    value: json({ mcpServers: { [spec.name]: serverEntry(spec, { typeKey: "type" }) } }),
  };
  const vscode = JSON.stringify({ name: spec.name, ...serverEntry(spec, { typeKey: "type" }) });
  installs.copilot = { kind: "command", where: "terminal (VS Code must be installed)", value: `code --add-mcp ${JSON.stringify(vscode)}` };

  if (needsHeaders) {
    for (const id of ["codex", "gemini"]) installs[id].note = "This server needs an auth header; add it in the agent's MCP config after running the command.";
  }
  return installs;
}

function skillInstalls(item) {
  const source = item.skillDir != null && item.url ? item.url : item.repo ? `https://github.com/${item.repo}` : "its source";
  const generic = {
    kind: "steps",
    value: [
      "This is an Agent Skill: a folder with a SKILL.md file, an open format several agents read",
      `Download the skill folder from ${source}`,
      "Copy it into your agent's skills folder (see your agent's docs for the location)",
    ],
  };
  const claudeCode = item.install?.command
    ? { kind: "command", where: item.install.command.startsWith("/") ? "claude code" : "terminal", value: item.install.command }
    : {
        kind: "steps",
        value: [`Download the skill folder from ${source}`, "Put it in ~/.claude/skills/ (all your projects) or .claude/skills/ inside one project", "Restart Claude Code; it picks the skill up automatically"],
      };
  return {
    "claude-code": claudeCode,
    claude: { kind: "steps", value: ["In Claude, open Settings → Capabilities → Skills", "Upload the skill folder as a .zip file"] },
    codex: generic,
    gemini: generic,
    cursor: generic,
    copilot: generic,
    other: generic,
  };
}

const SKILL_AGENTS = ["claude-code", "claude", "codex", "gemini", "cursor", "copilot", "other"];
// The Gemini app has no custom MCP connectors or skills; ChatGPT only takes remote MCP servers.
const MCP_AGENTS = AGENT_IDS.filter((id) => id !== "gemini-app");
// A GitHub repo is code to clone or run: only agents that work on your machine can use it.
// Chat apps (ChatGPT, the Claude and Gemini apps) only get repos tagged for them, or prompt collections.
const CHAT_APPS = new Set(["chatgpt", "claude", "gemini-app"]);
export const CODING_AGENTS = AGENT_IDS.filter((id) => !CHAT_APPS.has(id));

/** Agent ids an item supports. Must match the keys computeInstalls() produces (see tests). */
function agentsFor(item) {
  const extra = Object.keys(item.agentInstalls ?? {});
  let ids;
  if (item.type === "mcp") {
    const spec = parseClaudeMcpAdd(item.install?.command);
    ids = spec ? MCP_AGENTS.filter((id) => id !== "chatgpt" || spec.transport !== "stdio") : item.install?.command ? ["claude-code"] : [];
  } else if (item.type === "skill") ids = SKILL_AGENTS;
  else if (item.type === "plugin") ids = [...(item.install?.command ? ["claude-code"] : []), ...(item.alsoFor ?? [])];
  else if (item.type === "prompt") ids = AGENT_IDS;
  else if (item.agents?.length) ids = item.agents; // repos tagged at ingest
  else {
    item.genericAgents = true;
    ids = item.tags?.some((t) => t === "prompts" || t === "prompt") ? AGENT_IDS : CODING_AGENTS;
  }
  return [...new Set([...ids, ...extra])];
}

/**
 * Fills `agents` (ids) on a normalized item and a lazy `installs` (per-agent instructions).
 * Installs are generated on first read: building them for 15k items up front cost ~0.5s in the browser.
 */
export function applyAgentSupport(item) {
  item.agents = agentsFor(item);
  let cached;
  Object.defineProperty(item, "installs", {
    enumerable: true, // keeps it in JSON responses from the Node server
    configurable: true,
    get: () => (cached ??= computeInstalls(item)),
  });
  return item;
}

function computeInstalls(item) {
  let installs = {};
  if (item.type === "mcp") {
    const spec = parseClaudeMcpAdd(item.install?.command);
    installs = spec ? mcpInstalls(spec, item.install.command) : item.install?.command ? { "claude-code": { kind: "command", where: "terminal", value: item.install.command } } : {};
  } else if (item.type === "skill") {
    installs = skillInstalls(item);
  } else if (item.type === "plugin") {
    if (item.install?.command) installs["claude-code"] = { kind: "command", where: "claude code", value: item.install.command };
    for (const agent of item.alsoFor ?? []) {
      installs[agent] = { kind: "steps", value: [`This plugin also ships a ${AGENTS.find((a) => a.id === agent)?.short ?? agent} version`, item.repo ? `Follow the install notes at github.com/${item.repo}` : "Follow the install notes in its repository"] };
    }
  } else if (item.type === "prompt") {
    for (const id of AGENT_IDS) installs[id] = { kind: "prompt" };
  }

  // Source-specific installs (e.g. `gemini extensions install`) override the generated ones.
  Object.assign(installs, item.agentInstalls ?? {});
  if (item.install?.steps?.length && installs["claude-code"]) installs["claude-code"].steps = item.install.steps;
  return installs;
}

const AGENT_WORDS = [
  [/\bclaude code\b/, "claude-code"],
  [/\b(chat ?gpt|openai|gpt)\b/, "chatgpt"],
  [/\bcodex\b/, "codex"],
  [/\bgemini (app|web)\b|\bgemini\.google\b/, "gemini-app"],
  [/\bgemini\b/, "gemini"], // a bare "gemini" stays the CLI: the app only takes prompts, so it would hide most results
  [/\bcursor\b/, "cursor"],
  [/\b(copilot|vs ?code)\b/, "copilot"],
  [/\b(windsurf|codeium)\b/, "windsurf"],
  [/\b(claude app|claude desktop|claude\.ai)\b/, "claude"],
  // A bare "claude" is left alone: people say "let claude do X" about any Claude surface.
];

/** "an mcp server for chatgpt" -> { agent: "chatgpt", rest: "an mcp server for" } */
export function agentInQuery(text) {
  const lower = String(text ?? "").toLowerCase();
  for (const [re, id] of AGENT_WORDS) {
    if (re.test(lower)) return { agent: id, rest: lower.replace(re, " ") };
  }
  return { agent: null, rest: lower };
}
