import OpenAI from "openai";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCompleteRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  model?: string;
}

export interface LlmCompleteResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "other";
  model: string;
}

/** Provider-agnostic chat + function-calling seam. Tests inject a fake. */
export interface LlmClient {
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}

export function hasOpenAIKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function defaultModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4.1";
}

function parseArgs(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return { _parseError: raw };
  }
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "unknown", content: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      });
      continue;
    }
    if (m.role === "system") out.push({ role: "system", content: m.content ?? "" });
    else if (m.role === "user") out.push({ role: "user", content: m.content ?? "" });
    else out.push({ role: "assistant", content: m.content });
  }
  return out;
}

export class OpenAILlmClient implements LlmClient {
  constructor(
    private readonly client: OpenAI,
    readonly defaultModelName: string,
  ) {}

  static fromEnv(model = defaultModel()): OpenAILlmClient {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set (required for forge discover)");
    return new OpenAILlmClient(new OpenAI({ apiKey }), model);
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const model = request.model ?? this.defaultModelName;
    const res = await this.client.chat.completions.create({
      model,
      messages: toOpenAIMessages(request.messages),
      tools: request.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
    });
    const choice = res.choices[0];
    const msg = choice?.message;
    const finish = choice?.finish_reason;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
      .filter((c): c is Extract<typeof c, { type: "function" }> => c.type === "function")
      .map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: parseArgs(c.function.arguments),
      }));
    return {
      content: msg?.content ?? null,
      toolCalls,
      finishReason: finish === "tool_calls" ? "tool_calls" : finish === "length" ? "length" : finish === "stop" ? "stop" : "other",
      model: res.model ?? model,
    };
  }
}

export type ScriptTurn = LlmCompleteResponse | ((request: LlmCompleteRequest) => LlmCompleteResponse | Promise<LlmCompleteResponse>);

/** Deterministic LlmClient for unit tests. */
export class ScriptedLlmClient implements LlmClient {
  readonly calls: LlmCompleteRequest[] = [];
  private i = 0;

  constructor(
    private readonly script: ScriptTurn[],
    readonly modelName = "fake-llm",
  ) {}

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.calls.push(request);
    const turn = this.script[this.i++];
    if (!turn) {
      return { content: "script exhausted", toolCalls: [], finishReason: "stop", model: this.modelName };
    }
    return typeof turn === "function" ? turn(request) : turn;
  }
}

export function toolTurn(name: string, args: Record<string, unknown>, id = `call-${name}`): LlmCompleteResponse {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: args }],
    finishReason: "tool_calls",
    model: "fake-llm",
  };
}
