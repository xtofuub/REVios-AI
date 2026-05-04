import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

import { Hono } from "hono";

import {
  checkPromptArgvBudget,
  createCommandInvocation,
  detectAgents,
  getAgentDef,
  isKnownModel,
  resolveAgentBin,
  sanitizeCustomModel,
  spawnEnvForAgent,
} from "../lib/agents.ts";
import {
  createClaudeStreamHandler,
  createCopilotStreamHandler,
  createJsonEventStreamHandler,
  type AgentUiEvent,
} from "../lib/agent-streams.ts";

type ChatRequest = {
  agentId?: unknown;
  message?: unknown;
  model?: unknown;
  reasoning?: unknown;
  cwd?: unknown;
  session?: unknown;
};

type SseSender = (event: string, data: unknown) => void;

const encoder = new TextEncoder();

function errorPayload(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { code, message, ...extra };
}

function sseFrame(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function resolveEffectiveCwd(value: unknown) {
  const fallback = process.cwd();
  if (typeof value !== "string" || !value.trim()) return fallback;
  const resolved = path.resolve(value);
  try {
    return statSync(resolved).isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

function cleanSessionContext(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of [
    "platform",
    "mode",
    "device",
    "bundle",
    "pid",
    "identifier",
    "status",
    "fridaMajor",
    "href",
  ]) {
    const raw = input[key];
    if (typeof raw === "string") out[key] = raw.slice(0, 1000);
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === "boolean") out[key] = raw;
    else if (raw === null) out[key] = null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildApiGuide(apiBaseUrl: string, session: Record<string, unknown> | null) {
  const device = typeof session?.device === "string" ? session.device : ":device";
  const identifier =
    typeof session?.identifier === "string" ? session.identifier : ":identifier";
  const pid = typeof session?.pid === "number" ? String(session.pid) : ":pid";

  return [
    `Local Grapefruit API base: ${apiBaseUrl}`,
    "",
    "Use these HTTP APIs for live Grapefruit data when useful. Prefer GET routes for inspection. Only call POST/DELETE routes when the user explicitly asks for a mutating action.",
    "",
    "Read-only routes:",
    `- GET ${apiBaseUrl}/version`,
    `- GET ${apiBaseUrl}/devices`,
    `- GET ${apiBaseUrl}/device/${device}/apps`,
    `- GET ${apiBaseUrl}/device/${device}/processes`,
    `- GET ${apiBaseUrl}/device/${device}/info`,
    `- GET ${apiBaseUrl}/logs/${device}/${identifier}/agent`,
    `- GET ${apiBaseUrl}/logs/${device}/${identifier}/syslog`,
    `- GET ${apiBaseUrl}/history/http/${device}/${identifier}`,
    `- GET ${apiBaseUrl}/history/http/${device}/${identifier}/har`,
    `- GET ${apiBaseUrl}/history/nsurl/${device}/${identifier}`,
    `- GET ${apiBaseUrl}/history/nsurl/${device}/${identifier}/har`,
    `- GET ${apiBaseUrl}/pins/${device}/${identifier}`,
    `- GET ${apiBaseUrl}/hermes/${device}/${identifier}`,
    `- GET ${apiBaseUrl}/r2/sessions`,
    "",
    "Useful mutating routes, only on request:",
    `- POST ${apiBaseUrl}/device/${device}/kill/${pid}`,
    `- DELETE ${apiBaseUrl}/logs/${device}/${identifier}`,
    `- DELETE ${apiBaseUrl}/history/http/${device}/${identifier}`,
    `- DELETE ${apiBaseUrl}/history/nsurl/${device}/${identifier}`,
    `- DELETE ${apiBaseUrl}/pins/${device}/${identifier}`,
    "",
    "There is no Grapefruit MCP server exposed by this app yet. Work through the local HTTP API and the repository files unless the user asks for a dedicated MCP integration.",
  ].join("\n");
}

function composePrompt({
  apiBaseUrl,
  cwd,
  message,
  session,
}: {
  apiBaseUrl: string;
  cwd: string;
  message: string;
  session: Record<string, unknown> | null;
}) {
  return [
    "# Instructions",
    "",
    `Your working directory: ${cwd}`,
    "Read and write files relative to that directory unless the user asks otherwise.",
    "You are running inside Grapefruit, a dynamic instrumentation app for iOS and Android reverse engineering workflows.",
    "Do not assume the user can answer terminal permission prompts; keep actions non-interactive.",
    "",
    "# Grapefruit runtime",
    "",
    buildApiGuide(apiBaseUrl, session),
    "",
    session
      ? `Current workspace/session metadata:\n\n\`\`\`json\n${JSON.stringify(session, null, 2)}\n\`\`\``
      : "No active Grapefruit workspace metadata was supplied by the UI.",
    "",
    "---",
    "",
    "# User request",
    "",
    message,
  ].join("\n");
}

function cleanModel(defId: string, value: unknown) {
  if (typeof value !== "string" || value === "default") return "default";
  const def = getAgentDef(defId);
  if (!def) return null;
  if (isKnownModel(def, value)) return value;
  return sanitizeCustomModel(value);
}

function cleanReasoning(defId: string, value: unknown) {
  if (typeof value !== "string" || value === "default") return "default";
  const def = getAgentDef(defId);
  if (!def?.reasoningOptions) return "default";
  return def.reasoningOptions.some((option) => option.id === value) ? value : "default";
}

function attachStdoutParser(
  format: string,
  parserKind: string,
  child: ChildProcessWithoutNullStreams,
  send: SseSender,
) {
  const emitAgent = (event: AgentUiEvent) => send("agent", event);

  if (format === "claude-stream-json") {
    const handler = createClaudeStreamHandler(emitAgent);
    child.stdout.on("data", (chunk: string) => handler.feed(chunk));
    child.on("close", () => handler.flush());
    return;
  }

  if (format === "copilot-stream-json") {
    const handler = createCopilotStreamHandler(emitAgent);
    child.stdout.on("data", (chunk: string) => handler.feed(chunk));
    child.on("close", () => handler.flush());
    return;
  }

  if (format === "json-event-stream") {
    const handler = createJsonEventStreamHandler(parserKind, emitAgent);
    child.stdout.on("data", (chunk: string) => handler.feed(chunk));
    child.on("close", () => handler.flush());
    return;
  }

  child.stdout.on("data", (chunk: string) => {
    send("agent", { type: "text_delta", delta: chunk });
  });
}

function streamChat(body: ChatRequest, requestSignal: AbortSignal, apiBaseUrl: string) {
  let child: ChildProcessWithoutNullStreams | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const send: SseSender = (event, data) => {
        if (closed) return;
        controller.enqueue(sseFrame(event, data));
      };
      const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => {
        send("error", errorPayload(code, message, extra));
        send("end", { status: "failed", code: 1, signal: null });
        close();
      };

      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        fail("AGENT_EMPTY_MESSAGE", "Message is required.");
        return;
      }

      const agentId = typeof body.agentId === "string" ? body.agentId : "codex";
      const def = getAgentDef(agentId);
      if (!def) {
        fail("AGENT_NOT_FOUND", `Unknown agent: ${agentId}`);
        return;
      }

      const resolvedBin = resolveAgentBin(agentId);
      if (!resolvedBin) {
        fail("AGENT_NOT_INSTALLED", `${def.name} was not found on PATH.`);
        return;
      }

      const cwd = resolveEffectiveCwd(body.cwd);
      const session = cleanSessionContext(body.session);
      const composed = composePrompt({ apiBaseUrl, cwd, message, session });
      const promptBudgetError = checkPromptArgvBudget(def, composed);
      if (promptBudgetError) {
        fail(promptBudgetError.code, promptBudgetError.message, promptBudgetError);
        return;
      }

      const model = cleanModel(agentId, body.model);
      if (!model) {
        fail("AGENT_INVALID_MODEL", "Model id is not valid.");
        return;
      }
      const reasoning = cleanReasoning(agentId, body.reasoning);
      const args = def.buildArgs(composed, [], [], { model, reasoning }, { cwd });
      const env = spawnEnvForAgent(agentId, {
        ...process.env,
        ...(def.env ?? {}),
        GRAPEFRUIT_API_BASE: apiBaseUrl,
        IGF_API_BASE: apiBaseUrl,
        GRAPEFRUIT_WORKSPACE_CWD: cwd,
        ...(session ? { GRAPEFRUIT_SESSION_JSON: JSON.stringify(session) } : {}),
      });
      const invocation = createCommandInvocation({ command: resolvedBin, args, env });

      try {
        child = spawn(invocation.command, invocation.args, {
          cwd,
          env,
          stdio: [def.promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
          shell: false,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
      } catch (err) {
        fail(
          "AGENT_SPAWN_FAILED",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      const abort = () => {
        if (child && !child.killed) child.kill("SIGTERM");
      };
      requestSignal.addEventListener("abort", abort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      send("status", {
        status: "running",
        agentId,
        bin: resolvedBin,
        cwd,
        streamFormat: def.streamFormat,
        model,
        reasoning,
        session,
      });

      attachStdoutParser(def.streamFormat, def.eventParser ?? def.id, child, send);

      child.stderr.on("data", (chunk: string) => {
        send("stderr", { chunk });
      });

      child.on("error", (err) => {
        send("error", errorPayload("AGENT_EXECUTION_FAILED", err.message));
      });

      child.on("close", (code, signal) => {
        requestSignal.removeEventListener("abort", abort);
        const status = requestSignal.aborted
          ? "canceled"
          : code === 0
            ? "succeeded"
            : "failed";
        send("end", { status, code, signal });
        close();
      });

      if (def.promptViaStdin && child.stdin) {
        child.stdin.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code !== "EPIPE") {
            send("error", errorPayload("AGENT_STDIN_FAILED", `stdin: ${err.message}`));
          }
        });
        child.stdin.end(composed, "utf8");
      }
    },
    cancel() {
      if (child && !child.killed) child.kill("SIGTERM");
    },
  });
}

const routes = new Hono()
  .get("/agents", async (c) => {
    const agents = await detectAgents();
    return c.json({ agents, cwd: process.cwd() });
  })
  .post("/agent/chat", async (c) => {
    const body = await c.req.json<ChatRequest>().catch(() => ({}));
    const apiBaseUrl = `${new URL(c.req.url).origin}/api`;
    return new Response(streamChat(body, c.req.raw.signal, apiBaseUrl), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

export default routes;
