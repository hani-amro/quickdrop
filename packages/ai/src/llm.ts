// دمج WaFlow (MERGE_PLAN §3.2) — طبقة LLM رقيقة: fetch خام (كما كانت بـ WaFlow، بلا SDK)،
// قابلة للحقن كاملةً بالاختبارات (fake client). لا أسرار باللوغ أبداً.

export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema (صيغة أدوات Anthropic)
}

export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContentBlock[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: LlmContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: LlmUsage;
}

export interface LlmCompleteArgs {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
}

export interface LlmClient {
  complete(args: LlmCompleteArgs): Promise<LlmResponse>;
}

export class LlmApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`LLM API error ${status}: ${detail}`);
    this.name = "LlmApiError";
  }
}

export interface AnthropicClientOptions {
  apiKey: string;
  /** الافتراضي هايكو — وكيل طلبات طعام: الكلفة المناسبة؛ قابل للرفع لكل منصة. */
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** عميل Anthropic Messages API — fetch خام (نمط WaFlow المنقول، بلا تبعية SDK). */
export class AnthropicClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(args: LlmCompleteArgs): Promise<LlmResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: args.maxTokens,
        system: args.system,
        messages: args.messages,
        ...(args.tools.length > 0 ? { tools: args.tools } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new LlmApiError(res.status, text.slice(0, 300));
    const parsed = JSON.parse(text) as {
      content?: LlmContentBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const stop = parsed.stop_reason;
    return {
      content: parsed.content ?? [],
      stopReason: stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" ? stop : "other",
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
    };
  }
}
