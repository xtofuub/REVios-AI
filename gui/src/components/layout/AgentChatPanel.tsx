import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AlertCircle,
  Bot,
  Brain,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSession } from "@/context/SessionContext";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

interface ModelOption {
  id: string;
  label: string;
}

interface ReasoningOption {
  id: string;
  label: string;
}

interface AgentInfo {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  path?: string;
  version?: string | null;
  unavailableReason?: string;
  models: ModelOption[];
  reasoningOptions?: ReasoningOption[];
}

interface AgentsResponse {
  agents: AgentInfo[];
  cwd: string;
}

type MessageRole = "user" | "assistant" | "system";

interface TraceItem {
  id: string;
  icon: "tool" | "terminal" | "thinking" | "error";
  title: string;
  detail?: string;
  count?: number;
}

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  traces: TraceItem[];
  usage?: string;
}

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

interface AgentStreamEvent {
  type?: string;
  delta?: string;
  label?: string;
  model?: string;
  id?: string | null;
  name?: string | null;
  input?: unknown;
  toolUseId?: string | null;
  content?: string;
  isError?: boolean;
  line?: string;
  usage?: Record<string, number> | null;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stringifyDetail(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function trimMiddle(value: string, max = 1400) {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 24) / 2);
  return `${value.slice(0, keep)}\n... trimmed ...\n${value.slice(-keep)}`;
}

function normalizeDiagnostic(value: string) {
  const text = value.trim();
  if (!text) return "";
  if (/256-color support|YOLO mode is enabled|Ripgrep is not available/i.test(text)) {
    return "";
  }
  if (/Attempt \d+ failed:.*Retrying after/i.test(text)) {
    return "";
  }
  if (/rate_limit|status:\s*429|api_error_status"?\s*:\s*429|you've hit your limit/i.test(text)) {
    return "Rate limit hit. Try another model/provider or wait for the quota reset.";
  }
  if (/No authentication information found|not authenticated|run .*login|auth login|missing api key/i.test(text)) {
    return "Authentication missing. Log in to this CLI or set the token it expects.";
  }
  if (/access is denied|EACCES|EPERM/i.test(text)) {
    return "Windows denied execution of this CLI. Install a standalone CLI or fix the app execution alias.";
  }
  return trimMiddle(text);
}

function compactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return { event, data: data.join("\n") };
  }
}

async function readSseStream(
  response: Response,
  onEvent: (event: ParsedSseEvent) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (block) {
        const parsed = parseSseBlock(block);
        if (parsed) onEvent(parsed);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  const finalBlock = buffer.trim();
  if (finalBlock) {
    const parsed = parseSseBlock(finalBlock);
    if (parsed) onEvent(parsed);
  }
}

function formatUsage(usage: Record<string, number> | null | undefined) {
  if (!usage) return undefined;
  const labels: Record<string, string> = {
    input_tokens: "in",
    output_tokens: "out",
    thought_tokens: "think",
    cached_read_tokens: "cache",
    cached_write_tokens: "write",
    cache_creation_input_tokens: "write",
    cache_read_input_tokens: "cache",
  };
  const entries = Object.entries(usage).filter(([, value]) => typeof value === "number");
  if (entries.length === 0) return undefined;
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${labels[key] ?? key.replace(/_/g, " ")} ${compactNumber(value)}`)
    .join(" | ");
}

function traceIcon(kind: TraceItem["icon"]) {
  switch (kind) {
    case "thinking":
      return <Brain className="size-3.5" />;
    case "terminal":
      return <Terminal className="size-3.5" />;
    case "error":
      return <AlertCircle className="size-3.5" />;
    case "tool":
    default:
      return <Wrench className="size-3.5" />;
  }
}

function TraceList({ traces }: { traces: TraceItem[] }) {
  if (traces.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {traces.slice(-6).map((trace) => {
        const summary = trace.detail?.split(/\r?\n/).find(Boolean) ?? "";
        return (
          <details
            key={trace.id}
            className="group rounded-md border bg-muted/30 text-xs"
            open={trace.icon === "tool"}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 font-medium [&::-webkit-details-marker]:hidden">
              <span className="shrink-0 text-muted-foreground">{traceIcon(trace.icon)}</span>
              <span className="shrink-0 truncate">
                {trace.title}
                {trace.count && trace.count > 1 ? ` x${trace.count}` : ""}
              </span>
              {summary ? (
                <span className="min-w-0 truncate text-muted-foreground">{summary}</span>
              ) : null}
            </summary>
            {trace.detail ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words border-t px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {trace.detail}
              </pre>
            ) : null}
          </details>
        );
      })}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  return (
    <article
      className={
        isUser
          ? "max-w-full overflow-hidden rounded-md border border-primary/25 bg-primary/10 p-3"
          : isSystem
            ? "max-w-full overflow-hidden rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"
            : "max-w-full overflow-hidden rounded-md border bg-card p-3"
      }
    >
      <div className="mb-1 flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="shrink-0">{isUser ? "You" : isSystem ? "System" : "Agent"}</span>
        {message.usage ? (
          <Badge variant="secondary" className="min-w-0 max-w-full truncate" title={message.usage}>
            {message.usage}
          </Badge>
        ) : null}
      </div>
      {message.thinking ? (
        <div className="mb-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Brain className="size-3.5" />
            Thinking
          </div>
          <div className="whitespace-pre-wrap break-words">{message.thinking}</div>
        </div>
      ) : null}
      <TraceList traces={message.traces} />
      {message.content ? (
        <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
          {message.content}
        </div>
      ) : null}
      {!message.content && message.role === "assistant" && message.traces.length === 0 ? (
        <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Waiting
        </div>
      ) : null}
    </article>
  );
}

export function AgentChatPanel() {
  const grapefruitSession = useSession();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [serverCwd, setServerCwd] = useState("");
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState("opencode");
  const [selectedModel, setSelectedModel] = useState("default");
  const [selectedReasoning, setSelectedReasoning] = useState("default");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState("Idle");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const sessionPayload = useMemo(
    () => ({
      platform: grapefruitSession.platform,
      mode: grapefruitSession.mode,
      device: grapefruitSession.device,
      bundle: grapefruitSession.bundle,
      pid: grapefruitSession.pid,
      identifier: grapefruitSession.identifier,
      status: grapefruitSession.status,
      fridaMajor: grapefruitSession.fridaMajor,
      href: window.location.href,
    }),
    [
      grapefruitSession.platform,
      grapefruitSession.mode,
      grapefruitSession.device,
      grapefruitSession.bundle,
      grapefruitSession.pid,
      grapefruitSession.identifier,
      grapefruitSession.status,
      grapefruitSession.fridaMajor,
    ],
  );

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true);
    try {
      const response = await fetch("/api/agents");
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as AgentsResponse;
      setAgents(data.agents);
      setServerCwd(data.cwd);
      const preferred =
        data.agents.find((agent) => agent.id === selectedAgentId && agent.available) ??
        data.agents.find((agent) => agent.available) ??
        data.agents[0];
      if (preferred) setSelectedAgentId(preferred.id);
    } catch (err) {
      setRunStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAgents(false);
    }
  }, [selectedAgentId]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, runStatus]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!selectedAgent) return;
    if (!selectedAgent.models.some((model) => model.id === selectedModel)) {
      setSelectedModel("default");
    }
    if (
      selectedAgent.reasoningOptions &&
      !selectedAgent.reasoningOptions.some((option) => option.id === selectedReasoning)
    ) {
      setSelectedReasoning("default");
    }
  }, [selectedAgent, selectedModel, selectedReasoning]);

  useEffect(() => {
    if (!selectedAgent || selectedAgent.available) return;
    setRunStatus(selectedAgent.unavailableReason ?? `${selectedAgent.name} is not available.`);
  }, [selectedAgent]);

  const updateAssistant = useCallback(
    (assistantId: string, updater: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? updater(message) : message)),
      );
    },
    [],
  );

  const appendTrace = useCallback(
    (assistantId: string, trace: Omit<TraceItem, "id">) => {
      updateAssistant(assistantId, (message) => ({
        ...message,
        traces: (() => {
          const nextTrace = { ...trace, id: makeId("trace") };
          const last = message.traces.at(-1);
          if (
            last &&
            last.icon === nextTrace.icon &&
            last.title === nextTrace.title &&
            last.detail === nextTrace.detail
          ) {
            return [
              ...message.traces.slice(0, -1),
              { ...last, count: (last.count ?? 1) + 1 },
            ].slice(-18);
          }
          return [...message.traces, nextTrace].slice(-18);
        })(),
      }));
    },
    [updateAssistant],
  );

  const handleAgentEvent = useCallback(
    (assistantId: string, event: AgentStreamEvent) => {
      if (event.type === "text_delta" && typeof event.delta === "string") {
        updateAssistant(assistantId, (message) => ({
          ...message,
          content: message.content + event.delta,
        }));
        return;
      }

      if (event.type === "thinking_delta" && typeof event.delta === "string") {
        updateAssistant(assistantId, (message) => ({
          ...message,
          thinking: `${message.thinking ?? ""}${event.delta}`,
        }));
        return;
      }

      if (event.type === "status") {
        const label = event.model ? `${event.label}: ${event.model}` : event.label;
        setRunStatus(label ?? "Running");
        return;
      }

      if (event.type === "tool_use") {
        appendTrace(assistantId, {
          icon: "tool",
          title: event.name ?? "Tool",
          detail: stringifyDetail(event.input),
        });
        return;
      }

      if (event.type === "tool_result") {
        appendTrace(assistantId, {
          icon: event.isError ? "error" : "terminal",
          title: event.toolUseId ? `Result ${event.toolUseId}` : "Tool result",
          detail: event.content,
        });
        return;
      }

      if (event.type === "usage") {
        updateAssistant(assistantId, (message) => ({
          ...message,
          usage: formatUsage(event.usage),
        }));
        return;
      }

      if (event.type === "raw" && typeof event.line === "string") {
        const detail = normalizeDiagnostic(event.line);
        if (!detail) return;
        appendTrace(assistantId, {
          icon: "terminal",
          title: "Raw output",
          detail,
        });
      }
    },
    [appendTrace, updateAssistant],
  );

  const handleStreamEvent = useCallback(
    (assistantId: string, event: ParsedSseEvent) => {
      if (event.event === "agent") {
        handleAgentEvent(assistantId, event.data as AgentStreamEvent);
        return;
      }
      if (event.event === "stderr") {
        const chunk =
          typeof event.data === "object" &&
          event.data !== null &&
          "chunk" in event.data &&
          typeof event.data.chunk === "string"
            ? event.data.chunk
            : stringifyDetail(event.data);
        const detail = normalizeDiagnostic(chunk);
        if (!detail) return;
        appendTrace(assistantId, { icon: "error", title: "stderr", detail });
        return;
      }
      if (event.event === "status") {
        const data = event.data as { status?: string; cwd?: string };
        setRunStatus(data.status ?? "Running");
        if (data.cwd) setServerCwd(data.cwd);
        return;
      }
      if (event.event === "error") {
        const data = event.data as { message?: string; code?: string };
        const message = normalizeDiagnostic(data.message ?? stringifyDetail(event.data));
        setRunStatus(data.code ? `${data.code}: ${message}` : message);
        appendTrace(assistantId, { icon: "error", title: "Error", detail: message });
        return;
      }
      if (event.event === "end") {
        const data = event.data as { status?: string };
        setRunStatus(data.status ?? "Done");
      }
    },
    [appendTrace, handleAgentEvent],
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || running || !selectedAgent?.available) return;

    const userId = makeId("user");
    const assistantId = makeId("assistant");
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: text, traces: [] },
      { id: assistantId, role: "assistant", content: "", traces: [] },
    ]);
    setInput("");
    setRunning(true);
    setRunStatus("Starting");

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          model: selectedModel,
          reasoning: selectedReasoning,
          message: text,
          session: sessionPayload,
        }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(await response.text());
      await readSseStream(response, (event) => handleStreamEvent(assistantId, event));
    } catch (err) {
      if (abort.signal.aborted) {
        setRunStatus("Canceled");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setRunStatus(message);
        setMessages((current) => [
          ...current,
          { id: makeId("system"), role: "system", content: message, traces: [] },
        ]);
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setRunning(false);
    }
  }, [
    handleStreamEvent,
    input,
    running,
    selectedAgent,
    selectedModel,
    selectedReasoning,
    sessionPayload,
  ]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const stopRun = () => {
    abortRef.current?.abort();
    setRunStatus("Canceling");
  };

  const handleAgentChange = (value: string | null) => {
    if (!value) return;
    setSelectedAgentId(value);
    setSelectedModel("default");
    setSelectedReasoning("default");
  };

  const canSend = Boolean(input.trim() && selectedAgent?.available && !running);
  const modelOptions = selectedAgent?.models ?? [];
  const reasoningOptions = selectedAgent?.reasoningOptions ?? [];

  return (
    <aside className="flex h-full min-w-0 flex-col bg-background">
      <header className="border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Agent</div>
              <div className="truncate text-xs text-muted-foreground">
                {serverCwd || "Detecting"}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void loadAgents()}
            disabled={loadingAgents}
            title="Refresh agents"
          >
            {loadingAgents ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
          </Button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <Select value={selectedAgentId} onValueChange={handleAgentChange}>
            <SelectTrigger className="w-full" size="sm">
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {agents.map((agent) => (
                  <SelectItem
                    key={agent.id}
                    value={agent.id}
                    disabled={!agent.available}
                    title={agent.unavailableReason ?? agent.path}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{agent.name}</span>
                      <Badge variant={agent.available ? "secondary" : "outline"}>
                        {agent.available ? "ready" : "missing"}
                      </Badge>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={selectedModel} onValueChange={(value) => setSelectedModel(value ?? "default")}>
            <SelectTrigger className="w-full" size="sm">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {modelOptions.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {reasoningOptions.length > 0 ? (
            <Select
              value={selectedReasoning}
              onValueChange={(value) => setSelectedReasoning(value ?? "default")}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue placeholder="Reasoning" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {reasoningOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {loadingAgents
                ? "Detecting installed CLIs..."
                : selectedAgent?.available
                ? `${selectedAgent.name} is ready.`
                : selectedAgent?.unavailableReason ?? "No selected CLI is available."}
            </div>
          ) : (
            messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>
      <footer className="border-t p-3">
        <div className="mb-2 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={runStatus}>
            {runStatus}
          </span>
          {selectedAgent?.version ? (
            <span className="max-w-[45%] shrink-0 truncate" title={selectedAgent.version}>
              {selectedAgent.version}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message"
            className="max-h-40 min-h-20 resize-none text-sm"
            disabled={running}
          />
          <div className="flex justify-end gap-2">
            {running ? (
              <Button type="button" variant="outline" size="sm" onClick={stopRun}>
                <Square data-icon="inline-start" />
                Stop
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={() => void sendMessage()} disabled={!canSend}>
              <Send data-icon="inline-start" />
              Send
            </Button>
          </div>
        </div>
      </footer>
    </aside>
  );
}
