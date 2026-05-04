export type AgentUsage = Record<string, number>;

export type AgentUiEvent =
  | { type: "status"; label: string; model?: string; sessionId?: string; ttftMs?: number }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "tool_use"; id: string | null; name: string | null; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string | null;
      content: string;
      isError: boolean;
    }
  | {
      type: "usage";
      usage: AgentUsage | null;
      costUsd?: number | null;
      durationMs?: number;
      stopReason?: string | null;
    }
  | { type: "raw"; line: string };

type EventSink = (event: AgentUiEvent) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function safeParseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function formatOpenCodeUsage(tokens: unknown): AgentUsage | null {
  const data = asRecord(tokens);
  if (!data) return null;
  const usage: AgentUsage = {};
  if (typeof data.input === "number") usage.input_tokens = data.input;
  if (typeof data.output === "number") usage.output_tokens = data.output;
  if (typeof data.reasoning === "number") usage.thought_tokens = data.reasoning;
  const cache = asRecord(data.cache);
  if (cache) {
    if (typeof cache.read === "number") usage.cached_read_tokens = cache.read;
    if (typeof cache.write === "number") usage.cached_write_tokens = cache.write;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function handleOpenCodeEvent(
  obj: Record<string, unknown>,
  onEvent: EventSink,
  state: { openCodeToolUses: Set<string> },
) {
  const part = asRecord(obj.part) ?? {};

  if (obj.type === "step_start") {
    onEvent({ type: "status", label: "running" });
    return true;
  }

  if (obj.type === "text" && typeof part.text === "string" && part.text.length > 0) {
    onEvent({ type: "text_delta", delta: part.text });
    return true;
  }

  if (obj.type === "tool_use" && typeof part.tool === "string" && typeof part.callID === "string") {
    const statePart = asRecord(part.state);
    const sessionId = typeof obj.sessionID === "string" ? obj.sessionID : "session";
    const key = `${sessionId}:${part.callID}`;
    if (!state.openCodeToolUses.has(key)) {
      state.openCodeToolUses.add(key);
      onEvent({
        type: "tool_use",
        id: part.callID,
        name: part.tool,
        input: safeParseJson(statePart?.input) ?? statePart?.input ?? null,
      });
    }
    if (statePart?.status === "completed") {
      onEvent({
        type: "tool_result",
        toolUseId: part.callID,
        content: stringifyContent(statePart.output),
        isError: false,
      });
    }
    return true;
  }

  if (obj.type === "step_finish") {
    const usage = formatOpenCodeUsage(part.tokens);
    if (usage) {
      onEvent({
        type: "usage",
        usage,
        costUsd: numberField(part.cost),
      });
    }
    return true;
  }

  if (obj.type === "error") {
    const error = asRecord(obj.error);
    const errorData = asRecord(error?.data);
    const message =
      (typeof errorData?.message === "string" && errorData.message) ||
      (typeof error?.name === "string" && error.name) ||
      "OpenCode error";
    onEvent({ type: "raw", line: stringifyContent({ type: "error", message }) });
    return true;
  }

  return false;
}

function handleGeminiEvent(obj: Record<string, unknown>, onEvent: EventSink) {
  if (obj.type === "init") {
    onEvent({
      type: "status",
      label: "initializing",
      model: typeof obj.model === "string" ? obj.model : undefined,
    });
    return true;
  }

  if (obj.type === "message" && obj.role === "user") {
    return true;
  }

  if (obj.type === "tool_use") {
    if (obj.tool_name === "update_topic") return true;
    onEvent({
      type: "tool_use",
      id: typeof obj.tool_id === "string" ? obj.tool_id : null,
      name: typeof obj.tool_name === "string" ? obj.tool_name : null,
      input: obj.parameters ?? null,
    });
    return true;
  }

  if (obj.type === "tool_result") {
    if (typeof obj.tool_id === "string" && obj.tool_id.startsWith("update_topic_")) {
      return true;
    }
    onEvent({
      type: "tool_result",
      toolUseId: typeof obj.tool_id === "string" ? obj.tool_id : null,
      content: stringifyContent(obj.output),
      isError: obj.status === "error" || obj.status === "failed",
    });
    return true;
  }

  if (
    obj.type === "message" &&
    obj.role === "assistant" &&
    typeof obj.content === "string" &&
    obj.content.length > 0
  ) {
    onEvent({ type: "text_delta", delta: obj.content });
    return true;
  }

  const stats = asRecord(obj.stats);
  if (obj.type === "result" && stats) {
    const usage: AgentUsage = {};
    if (typeof stats.input_tokens === "number") usage.input_tokens = stats.input_tokens;
    if (typeof stats.output_tokens === "number") usage.output_tokens = stats.output_tokens;
    if (typeof stats.cached === "number") usage.cached_read_tokens = stats.cached;
    onEvent({
      type: "usage",
      usage,
      durationMs: numberField(stats.duration_ms),
    });
    return true;
  }

  return false;
}

function extractCursorText(message: unknown): string {
  const msg = asRecord(message);
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  return blocks
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function emitCursorTextDelta(
  text: string,
  onEvent: EventSink,
  state: { cursorTextSoFar: string },
) {
  if (!state.cursorTextSoFar) {
    state.cursorTextSoFar = text;
    onEvent({ type: "text_delta", delta: text });
    return;
  }
  if (text === state.cursorTextSoFar) return;
  if (text.startsWith(state.cursorTextSoFar)) {
    const delta = text.slice(state.cursorTextSoFar.length);
    if (delta) onEvent({ type: "text_delta", delta });
    state.cursorTextSoFar = text;
    return;
  }
  state.cursorTextSoFar += text;
  onEvent({ type: "text_delta", delta: text });
}

function handleCursorEvent(
  obj: Record<string, unknown>,
  onEvent: EventSink,
  state: { cursorTextSoFar: string },
) {
  if (obj.type === "system" && obj.subtype === "init") {
    onEvent({
      type: "status",
      label: "initializing",
      model: typeof obj.model === "string" ? obj.model : undefined,
    });
    return true;
  }

  if (obj.type === "assistant" && obj.message) {
    const text = extractCursorText(obj.message);
    if (!text) return false;
    emitCursorTextDelta(text, onEvent, state);
    return true;
  }

  const usageRaw = asRecord(obj.usage);
  if (obj.type === "result" && usageRaw) {
    const usage: AgentUsage = {};
    if (typeof usageRaw.inputTokens === "number") usage.input_tokens = usageRaw.inputTokens;
    if (typeof usageRaw.outputTokens === "number") usage.output_tokens = usageRaw.outputTokens;
    if (typeof usageRaw.cacheReadTokens === "number") {
      usage.cached_read_tokens = usageRaw.cacheReadTokens;
    }
    if (typeof usageRaw.cacheWriteTokens === "number") {
      usage.cached_write_tokens = usageRaw.cacheWriteTokens;
    }
    onEvent({
      type: "usage",
      usage,
      durationMs: numberField(obj.duration_ms),
    });
    return true;
  }

  return false;
}

function handleCodexEvent(
  obj: Record<string, unknown>,
  onEvent: EventSink,
  state: { codexToolUses: Set<string> },
) {
  if (obj.type === "thread.started") {
    onEvent({ type: "status", label: "initializing" });
    return true;
  }

  if (obj.type === "turn.started") {
    onEvent({ type: "status", label: "running" });
    return true;
  }

  const item = asRecord(obj.item);
  if (obj.type === "item.started" && item?.type === "command_execution" && typeof item.id === "string") {
    if (!state.codexToolUses.has(item.id)) {
      state.codexToolUses.add(item.id);
      onEvent({
        type: "tool_use",
        id: item.id,
        name: "Bash",
        input: { command: typeof item.command === "string" ? item.command : "" },
      });
    }
    return true;
  }

  if (obj.type === "item.completed" && item?.type === "command_execution" && typeof item.id === "string") {
    if (!state.codexToolUses.has(item.id)) {
      state.codexToolUses.add(item.id);
      onEvent({
        type: "tool_use",
        id: item.id,
        name: "Bash",
        input: { command: typeof item.command === "string" ? item.command : "" },
      });
    }
    onEvent({
      type: "tool_result",
      toolUseId: item.id,
      content: stringifyContent(item.aggregated_output ?? ""),
      isError: typeof item.exit_code === "number" ? item.exit_code !== 0 : item.status === "failed",
    });
    return true;
  }

  if (
    obj.type === "item.completed" &&
    item?.type === "agent_message" &&
    typeof item.text === "string" &&
    item.text.length > 0
  ) {
    onEvent({ type: "text_delta", delta: item.text });
    return true;
  }

  const usageRaw = asRecord(obj.usage);
  if (obj.type === "turn.completed" && usageRaw) {
    const usage: AgentUsage = {};
    if (typeof usageRaw.input_tokens === "number") usage.input_tokens = usageRaw.input_tokens;
    if (typeof usageRaw.output_tokens === "number") usage.output_tokens = usageRaw.output_tokens;
    if (typeof usageRaw.cached_input_tokens === "number") {
      usage.cached_read_tokens = usageRaw.cached_input_tokens;
    }
    onEvent({ type: "usage", usage });
    return true;
  }

  return false;
}

export function createJsonEventStreamHandler(kind: string, onEvent: EventSink) {
  let buffer = "";
  const state = {
    cursorTextSoFar: "",
    openCodeToolUses: new Set<string>(),
    codexToolUses: new Set<string>(),
  };

  function handleLine(line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onEvent({ type: "raw", line });
      return;
    }
    const obj = asRecord(parsed);
    if (!obj) return;

    if (kind === "opencode" && handleOpenCodeEvent(obj, onEvent, state)) return;
    if (kind === "gemini" && handleGeminiEvent(obj, onEvent)) return;
    if (kind === "cursor-agent" && handleCursorEvent(obj, onEvent, state)) return;
    if (kind === "codex" && handleCodexEvent(obj, onEvent, state)) return;

    onEvent({ type: "raw", line });
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
        nl = buffer.indexOf("\n");
      }
    },
    flush() {
      const rem = buffer.trim();
      buffer = "";
      if (rem) handleLine(rem);
    },
  };
}

type ClaudeBlockState = {
  type?: unknown;
  name?: unknown;
  id?: unknown;
  input: string;
};

export function createClaudeStreamHandler(onEvent: EventSink) {
  let buffer = "";
  const blocks = new Map<string, ClaudeBlockState>();
  let currentMessageId: string | null = null;
  const textStreamed = new Set<string>();

  function blockKey(index: unknown) {
    return `${currentMessageId ?? "anon"}:${String(index)}`;
  }

  function handleStreamEvent(evRaw: unknown) {
    const ev = asRecord(evRaw);
    if (!ev) return;

    if (ev.type === "message_start") {
      const message = asRecord(ev.message);
      currentMessageId = typeof message?.id === "string" ? message.id : null;
      if (typeof ev.ttft_ms === "number") {
        onEvent({ type: "status", label: "streaming", ttftMs: ev.ttft_ms });
      }
      return;
    }

    const contentBlock = asRecord(ev.content_block);
    if (ev.type === "content_block_start" && contentBlock) {
      const key = blockKey(ev.index);
      blocks.set(key, {
        type: contentBlock.type,
        name: contentBlock.name,
        id: contentBlock.id,
        input: "",
      });
      if (contentBlock.type === "thinking") onEvent({ type: "thinking_start" });
      return;
    }

    const delta = asRecord(ev.delta);
    if (ev.type === "content_block_delta" && delta) {
      const state = blocks.get(blockKey(ev.index));
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: "text_delta", delta: delta.text });
        return;
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: "thinking_delta", delta: delta.thinking });
        return;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        if (state?.type === "tool_use") state.input += delta.partial_json;
      }
      return;
    }

    if (ev.type === "content_block_stop") {
      blocks.delete(blockKey(ev.index));
    }
  }

  function handleObject(objRaw: unknown) {
    const obj = asRecord(objRaw);
    if (!obj) return;

    if (obj.type === "system" && obj.subtype === "init") {
      onEvent({
        type: "status",
        label: "initializing",
        model: typeof obj.model === "string" ? obj.model : undefined,
        sessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
      });
      return;
    }

    if (obj.type === "system" && obj.subtype === "status") {
      onEvent({ type: "status", label: typeof obj.status === "string" ? obj.status : "working" });
      return;
    }

    if (obj.type === "stream_event") {
      handleStreamEvent(obj.event);
      return;
    }

    const message = asRecord(obj.message);
    const content = Array.isArray(message?.content) ? message.content : null;
    if (obj.type === "assistant" && content) {
      currentMessageId = typeof message?.id === "string" ? message.id : currentMessageId;
      const msgId = typeof message?.id === "string" ? message.id : null;
      const alreadyStreamed = msgId ? textStreamed.has(msgId) : false;
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (!block) continue;
        if (block.type === "tool_use") {
          onEvent({
            type: "tool_use",
            id: typeof block.id === "string" ? block.id : null,
            name: typeof block.name === "string" ? block.name : null,
            input: block.input ?? null,
          });
        } else if (!alreadyStreamed && block.type === "text" && typeof block.text === "string" && block.text) {
          onEvent({ type: "text_delta", delta: block.text });
        } else if (
          !alreadyStreamed &&
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking
        ) {
          onEvent({ type: "thinking_delta", delta: block.thinking });
        }
      }
      return;
    }

    if (obj.type === "user" && content) {
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (block?.type === "tool_result") {
          onEvent({
            type: "tool_result",
            toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
            content: stringifyToolResult(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
      return;
    }

    if (obj.type === "result") {
      onEvent({
        type: "usage",
        usage: asRecord(obj.usage) as AgentUsage | null,
        costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null,
        durationMs: numberField(obj.duration_ms),
        stopReason: typeof obj.stop_reason === "string" ? obj.stop_reason : null,
      });
    }
  }

  function handleLine(line: string) {
    try {
      handleObject(JSON.parse(line));
    } catch {
      onEvent({ type: "raw", line });
    }
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
        nl = buffer.indexOf("\n");
      }
    },
    flush() {
      const rem = buffer.trim();
      buffer = "";
      if (rem) handleLine(rem);
    },
  };
}

export function createCopilotStreamHandler(onEvent: EventSink) {
  let buffer = "";

  function handleObject(objRaw: unknown) {
    const obj = asRecord(objRaw);
    if (!obj || typeof obj.type !== "string") return;
    const data = asRecord(obj.data) ?? {};

    switch (obj.type) {
      case "session.tools_updated":
        if (typeof data.model === "string") {
          onEvent({ type: "status", label: "initializing", model: data.model });
        }
        return;
      case "assistant.turn_start":
        onEvent({ type: "status", label: "streaming" });
        return;
      case "assistant.reasoning_delta":
        if (typeof data.deltaContent === "string") {
          onEvent({ type: "thinking_delta", delta: data.deltaContent });
        }
        return;
      case "assistant.message_delta":
        if (typeof data.deltaContent === "string") {
          onEvent({ type: "text_delta", delta: data.deltaContent });
        }
        return;
      case "tool.execution_start":
        onEvent({
          type: "tool_use",
          id: typeof data.toolCallId === "string" ? data.toolCallId : null,
          name: typeof data.toolName === "string" ? data.toolName : null,
          input: data.arguments ?? null,
        });
        return;
      case "tool.execution_complete":
        onEvent({
          type: "tool_result",
          toolUseId: typeof data.toolCallId === "string" ? data.toolCallId : null,
          content: stringifyResult(data.result),
          isError: data.success === false,
        });
        return;
      case "result": {
        const usage = asRecord(obj.usage) as AgentUsage | null;
        const duration =
          usage && typeof usage.sessionDurationMs === "number"
            ? usage.sessionDurationMs
            : undefined;
        onEvent({
          type: "usage",
          usage,
          stopReason: obj.success === true || obj.exitCode === 0 ? "completed" : "error",
          durationMs: duration,
        });
      }
    }
  }

  function handleLine(line: string) {
    try {
      handleObject(JSON.parse(line));
    } catch {
      onEvent({ type: "raw", line });
    }
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
        nl = buffer.indexOf("\n");
      }
    },
    flush() {
      const rem = buffer.trim();
      buffer = "";
      if (rem) handleLine(rem);
    },
  };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        const item = asRecord(entry);
        return item?.type === "text" && typeof item.text === "string"
          ? item.text
          : stringifyContent(entry);
      })
      .join("\n");
  }
  return stringifyContent(content);
}

function stringifyResult(value: unknown): string {
  const data = asRecord(value);
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof data?.content === "string") return data.content;
  if (typeof data?.detailedContent === "string") return data.detailedContent;
  return stringifyContent(value);
}
