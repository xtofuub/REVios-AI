import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter } from "node:path";
import path from "node:path";
import { homedir } from "node:os";

export type StreamFormat =
  | "claude-stream-json"
  | "copilot-stream-json"
  | "json-event-stream"
  | "plain";

export interface ModelOption {
  id: string;
  label: string;
}

export interface ReasoningOption {
  id: string;
  label: string;
}

export interface AgentRunOptions {
  model?: string;
  reasoning?: string;
}

export interface AgentRuntimeContext {
  cwd?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  bin: string;
  fallbackBins?: string[];
  versionArgs: string[];
  helpArgs?: string[];
  capabilityFlags?: Record<string, string>;
  listModels?: {
    args: string[];
    parse: (stdout: string) => ModelOption[] | null;
    timeoutMs?: number;
  };
  fallbackModels: ModelOption[];
  reasoningOptions?: ReasoningOption[];
  env?: Record<string, string>;
  promptViaStdin?: boolean;
  streamFormat: StreamFormat;
  eventParser?: string;
  maxPromptArgBytes?: number;
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs: string[],
    options: AgentRunOptions,
    runtimeContext: AgentRuntimeContext,
  ) => string[];
}

export type PublicAgent = Omit<
  AgentDefinition,
  | "buildArgs"
  | "listModels"
  | "fallbackModels"
  | "helpArgs"
  | "capabilityFlags"
  | "fallbackBins"
  | "maxPromptArgBytes"
  | "env"
> & {
  available: boolean;
  models: ModelOption[];
  path?: string;
  version?: string | null;
  unavailableReason?: string;
};

export type CommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const DEFAULT_MODEL_OPTION: ModelOption = {
  id: "default",
  label: "Default (CLI config)",
};

const agentCapabilities = new Map<string, Record<string, boolean>>();
const liveModelCache = new Map<string, Set<string>>();

function clampCodexReasoning(modelId: string | undefined, effort: string) {
  const raw = String(modelId ?? "").trim();
  const id = raw.includes("/") ? raw.split("/").pop() : raw;
  const isGpt5LateFamily =
    !id ||
    id === "default" ||
    id.startsWith("gpt-5.2") ||
    id.startsWith("gpt-5.3") ||
    id.startsWith("gpt-5.4") ||
    id.startsWith("gpt-5.5");
  if (isGpt5LateFamily && effort === "minimal") return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") {
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  }
  return effort;
}

function parseLineSeparatedModels(stdout: string): ModelOption[] {
  const ids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const seen = new Set<string>();
  const out = [DEFAULT_MODEL_OPTION];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}

export const AGENT_DEFS: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    fallbackBins: ["openclaude"],
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    capabilityFlags: {
      "--include-partial-messages": "partialMessages",
      "--add-dir": "addDir",
    },
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "sonnet", label: "Sonnet (alias)" },
      { id: "opus", label: "Opus (alias)" },
      { id: "haiku", label: "Haiku (alias)" },
      { id: "claude-opus-4-5", label: "claude-opus-4-5" },
      { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
    buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}) => {
      const caps = agentCapabilities.get("claude") ?? {};
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (caps.partialMessages) args.push("--include-partial-messages");
      if (options.model && options.model !== "default") args.push("--model", options.model);
      const dirs = extraAllowedDirs.filter((dir) => dir.length > 0);
      if (dirs.length > 0 && caps.addDir !== false) args.push("--add-dir", ...dirs);
      args.push("--permission-mode", "bypassPermissions");
      return args;
    },
    promptViaStdin: true,
    streamFormat: "claude-stream-json",
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "gpt-5-codex", label: "gpt-5-codex" },
      { id: "gpt-5", label: "gpt-5" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
    reasoningOptions: [
      { id: "default", label: "Default" },
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
    buildArgs: (_prompt, _imagePaths, _extra, options = {}, runtimeContext = {}) => {
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--full-auto",
        "-c",
        "sandbox_workspace_write.network_access=true",
      ];
      if (process.env.IGF_CODEX_DISABLE_PLUGINS === "1") args.push("--disable", "plugins");
      if (runtimeContext.cwd) args.push("-C", runtimeContext.cwd);
      if (options.model && options.model !== "default") args.push("--model", options.model);
      if (options.reasoning && options.reasoning !== "default") {
        const effort = clampCodexReasoning(options.model, options.reasoning);
        args.push("-c", `model_reasoning_effort="${effort}"`);
      }
      return args;
    },
    promptViaStdin: true,
    streamFormat: "json-event-stream",
    eventParser: "codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    versionArgs: ["--version"],
    fallbackModels: [
      { id: "default", label: "Default (gemini-2.5-flash)" },
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    ],
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    buildArgs: (_prompt, _imagePaths, _extra, options = {}) => {
      const args = [
        "--prompt",
        " ",
        "--output-format",
        "stream-json",
        "--yolo",
        "--skip-trust",
      ];
      args.push("--model", options.model && options.model !== "default" ? options.model : "gemini-2.5-flash");
      return args;
    },
    promptViaStdin: true,
    streamFormat: "json-event-stream",
    eventParser: "gemini",
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    versionArgs: ["--version"],
    listModels: {
      args: ["models"],
      parse: parseLineSeparatedModels,
      timeoutMs: 8000,
    },
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { id: "openai/gpt-5", label: "openai/gpt-5" },
      { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
    ],
    buildArgs: (_prompt, _imagePaths, _extra, options = {}) => {
      const args = ["run", "--format", "json", "--dangerously-skip-permissions"];
      if (options.model && options.model !== "default") args.push("--model", options.model);
      args.push("-");
      return args;
    },
    promptViaStdin: true,
    streamFormat: "json-event-stream",
    eventParser: "opencode",
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    listModels: {
      args: ["models"],
      timeoutMs: 5000,
      parse: (stdout) => {
        const trimmed = stdout.trim();
        if (!trimmed || /no models available/i.test(trimmed)) return null;
        return parseLineSeparatedModels(trimmed);
      },
    },
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "auto", label: "auto" },
      { id: "sonnet-4", label: "sonnet-4" },
      { id: "sonnet-4-thinking", label: "sonnet-4-thinking" },
      { id: "gpt-5", label: "gpt-5" },
    ],
    buildArgs: (_prompt, _imagePaths, _extra, options = {}, runtimeContext = {}) => {
      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--trust",
      ];
      if (runtimeContext.cwd) args.push("--workspace", runtimeContext.cwd);
      if (options.model && options.model !== "default") args.push("--model", options.model);
      return args;
    },
    promptViaStdin: true,
    streamFormat: "json-event-stream",
    eventParser: "cursor-agent",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    bin: "qwen",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "qwen3-coder-plus", label: "qwen3-coder-plus" },
      { id: "qwen3-coder-flash", label: "qwen3-coder-flash" },
    ],
    buildArgs: (_prompt, _imagePaths, _extra, options = {}) => {
      const args = ["--yolo"];
      if (options.model && options.model !== "default") args.push("--model", options.model);
      args.push("-");
      return args;
    },
    promptViaStdin: true,
    streamFormat: "plain",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    bin: "copilot",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { id: "gpt-5.2", label: "GPT-5.2" },
    ],
    buildArgs: (prompt, _imagePaths, extraAllowedDirs = [], options = {}) => {
      const args = [
        "-p",
        prompt,
        "--allow-all",
        "--output-format",
        "json",
        "--no-color",
        "--log-level",
        "error",
      ];
      if (options.model && options.model !== "default") args.push("--model", options.model);
      for (const dir of extraAllowedDirs.filter((item) => item.length > 0)) {
        args.push("--add-dir", dir);
      }
      return args;
    },
    promptViaStdin: false,
    maxPromptArgBytes: 30_000,
    streamFormat: "copilot-stream-json",
  },
  {
    id: "deepseek",
    name: "DeepSeek TUI",
    bin: "deepseek",
    versionArgs: ["--version"],
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
    ],
    buildArgs: (prompt, _imagePaths, _extra, options = {}) => {
      const args = ["exec", "--auto"];
      if (options.model && options.model !== "default") args.push("--model", options.model);
      args.push(prompt);
      return args;
    },
    maxPromptArgBytes: 30_000,
    streamFormat: "plain",
  },
];

function quoteWindowsCommandArg(value: string): string {
  if (!/[\s"&<>|^%]/.test(value)) return value;
  const escaped = value.replace(/"/g, '""').replace(/%/g, '"^%"');
  return `"${escaped}"`;
}

function buildCmdShimInvocation(command: string, args: string[], env: NodeJS.ProcessEnv): CommandInvocation {
  const inner = [command, ...args].map(quoteWindowsCommandArg).join(" ");
  return {
    args: ["/d", "/s", "/c", `"${inner}"`],
    command: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
    windowsVerbatimArguments: true,
  };
}

function buildNpmCmdShimInvocation(command: string, args: string[]): CommandInvocation | null {
  let content = "";
  try {
    content = readFileSync(command, "utf8");
  } catch {
    return null;
  }

  const match = content.match(/"%_prog%"\s+"([^"]+)"\s+%\*/i);
  if (!match) return null;

  const shimDir = path.dirname(command);
  const script = match[1].replace(/%dp0%\\?/gi, "");
  const nodePath = path.join(shimDir, "node.exe");
  return {
    command: existsSync(nodePath) ? nodePath : "node",
    args: [path.join(shimDir, script), ...args],
  };
}

export function createCommandInvocation({
  args = [],
  command,
  env = process.env,
}: {
  args?: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
}): CommandInvocation {
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(command)) {
    const npmShim = buildNpmCmdShimInvocation(command, args);
    if (npmShim) return npmShim;
    return buildCmdShimInvocation(command, args, env);
  }
  return { args, command };
}

type CommandResult = {
  stdout: string;
  stderr: string;
};

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const invocation = createCommandInvocation({ command, args });
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${options.timeoutMs ?? 5000}ms`));
    }, options.timeoutMs ?? 5000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length + stderr.length > maxBuffer && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error(`command exceeded output buffer of ${maxBuffer} bytes`));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stdout.length + stderr.length > maxBuffer && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error(`command exceeded output buffer of ${maxBuffer} bytes`));
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `command exited code=${code} signal=${signal ?? "none"}`));
      }
    });
  });
}

function existingDirsUnder(root: string, segments: string[] = []) {
  const dirs: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name, ...segments);
    if (existsSync(full)) dirs.push(full);
  }
  return dirs;
}

const TOOLCHAIN_DIR_CACHE_TTL_MS = 5000;
let cachedToolchainHome: string | null = null;
let cachedToolchainDirsAt = 0;
let cachedToolchainDirs: string[] = [];

function userToolchainDirs(homeOverride = homedir()) {
  const now = Date.now();
  if (
    cachedToolchainHome === homeOverride &&
    now - cachedToolchainDirsAt < TOOLCHAIN_DIR_CACHE_TTL_MS
  ) {
    return cachedToolchainDirs;
  }

  const home = homeOverride;
  const windowsDirs =
    process.platform === "win32"
      ? [
          path.join(home, "AppData", "Roaming", "npm"),
          path.join(home, "AppData", "Local", "pnpm"),
          path.join(home, "AppData", "Local", "Microsoft", "WindowsApps"),
        ]
      : [];

  cachedToolchainHome = home;
  cachedToolchainDirsAt = now;
  cachedToolchainDirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "pnpm"),
    ...windowsDirs,
    ...(process.platform !== "win32" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
    ...existingDirsUnder(path.join(home, ".local", "share", "mise", "installs", "node"), ["bin"]),
    ...existingDirsUnder(path.join(home, ".nvm", "versions", "node"), ["bin"]),
    ...existingDirsUnder(path.join(home, ".local", "share", "fnm", "node-versions"), [
      "installation",
      "bin",
    ]),
  ];
  return cachedToolchainDirs;
}

function resolvePathDirs() {
  const seen = new Set<string>();
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...userToolchainDirs()];
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

export function resolveOnPath(bin: string) {
  if (path.isAbsolute(bin) && existsSync(bin)) return bin;
  const winExts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  const extname = path.extname(bin);
  const exts = process.platform === "win32" ? (extname ? [""] : winExts) : [""];
  for (const dir of resolvePathDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export function resolveAgentExecutable(def: AgentDefinition) {
  const candidates = [def.bin, ...(def.fallbackBins ?? [])];
  for (const bin of candidates) {
    const resolved = resolveOnPath(bin);
    if (resolved) return resolved;
  }
  return null;
}

async function fetchModels(def: AgentDefinition, resolvedBin: string) {
  if (!def.listModels) return def.fallbackModels;
  try {
    const result = await runCommand(resolvedBin, def.listModels.args, {
      timeoutMs: def.listModels.timeoutMs ?? 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = def.listModels.parse(result.stdout);
    return parsed && parsed.length > 0 ? parsed : def.fallbackModels;
  } catch {
    return def.fallbackModels;
  }
}

function stripFns(def: AgentDefinition): Omit<PublicAgent, "available" | "models" | "path" | "version"> {
  const {
    buildArgs: _buildArgs,
    listModels: _listModels,
    fallbackModels: _fallbackModels,
    helpArgs: _helpArgs,
    capabilityFlags: _capabilityFlags,
    fallbackBins: _fallbackBins,
    maxPromptArgBytes: _maxPromptArgBytes,
    env: _env,
    ...rest
  } = def;
  return rest;
}

async function probe(def: AgentDefinition): Promise<PublicAgent> {
  const resolved = resolveAgentExecutable(def);
  if (!resolved) {
    return {
      ...stripFns(def),
      models: def.fallbackModels,
      available: false,
      unavailableReason: `${def.bin} was not found on PATH.`,
    };
  }

  let version: string | null = null;
  let versionProbeError: string | null = null;
  try {
    const { stdout } = await runCommand(resolved, def.versionArgs, { timeoutMs: 3000 });
    version = stdout.trim().split(/\r?\n/)[0] ?? null;
  } catch (err) {
    versionProbeError = err instanceof Error ? err.message : String(err);
    version = null;
  }

  if (
    versionProbeError &&
    /EACCES|EPERM|access is denied/i.test(versionProbeError)
  ) {
    return {
      ...stripFns(def),
      models: def.fallbackModels,
      available: false,
      path: resolved,
      version,
      unavailableReason:
        process.platform === "win32" && resolved.toLowerCase().includes("\\windowsapps\\")
          ? "Windows denied direct execution of this packaged app. Install the standalone CLI or enable a runnable app execution alias."
          : versionProbeError,
    };
  }

  if (def.helpArgs && def.capabilityFlags) {
    const caps: Record<string, boolean> = {};
    try {
      const { stdout } = await runCommand(resolved, def.helpArgs, {
        timeoutMs: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const [flag, key] of Object.entries(def.capabilityFlags)) {
        caps[key] = stdout.includes(flag);
      }
    } catch {
      // Leave caps empty. buildArgs will skip optional flags.
    }
    agentCapabilities.set(def.id, caps);
  }

  const models = await fetchModels(def, resolved);
  return {
    ...stripFns(def),
    models,
    available: true,
    path: resolved,
    version,
  };
}

export async function detectAgents() {
  const results = await Promise.all(AGENT_DEFS.map(probe));
  for (const agent of results) rememberLiveModels(agent.id, agent.models);
  return results;
}

export function getAgentDef(id: string) {
  return AGENT_DEFS.find((agent) => agent.id === id) ?? null;
}

export function resolveAgentBin(id: string) {
  const def = getAgentDef(id);
  return def ? resolveAgentExecutable(def) : null;
}

export function spawnEnvForAgent(_agentId: string, baseEnv: NodeJS.ProcessEnv) {
  const env = { ...baseEnv };
  return env;
}

export function rememberLiveModels(agentId: string, models: ModelOption[]) {
  liveModelCache.set(
    agentId,
    new Set(models.map((model) => model.id).filter((id) => typeof id === "string")),
  );
}

export function isKnownModel(def: AgentDefinition, modelId: string) {
  const live = liveModelCache.get(def.id);
  if (live?.has(modelId)) return true;
  return def.fallbackModels.some((model) => model.id === modelId);
}

export function sanitizeCustomModel(id: unknown) {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(trimmed)) return null;
  return trimmed;
}

export function checkPromptArgvBudget(def: AgentDefinition, composed: string) {
  if (typeof def.maxPromptArgBytes !== "number") return null;
  const bytes = Buffer.byteLength(composed, "utf8");
  if (bytes <= def.maxPromptArgBytes) return null;
  return {
    code: "AGENT_PROMPT_TOO_LARGE",
    message:
      `${def.name} requires the prompt as a command-line argument and this prompt is too large ` +
      `(${bytes} > ${def.maxPromptArgBytes} bytes). Use a stdin-capable adapter or shorten the prompt.`,
    bytes,
    limit: def.maxPromptArgBytes,
  };
}
