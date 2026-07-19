import { spendAiBudget, withTenant, writeOutbox, type Db } from "@quickdrop/db";
import { executeTool, TOOL_DEFS, type ToolContext } from "./tools.js";
import type { LlmClient, LlmContentBlock, LlmMessage, LlmUsage } from "./llm.js";

// دمج WaFlow (MERGE_PLAN §3.2) — حلقة المحرك: تُنقل بنيتها (MAX_ROUNDS=5، إعادة فحص
// الميزانية كل جولة) مع إصلاحاتها:
// - الإنفاق **بالتوكنات لا بالأفعال** (باغ WaFlow: عدّ الأفعال)، بحساب صحيح bigint سنتات
//   وخصم ذرّي بشرط السقف (R-18 — spendAiBudget).
// - **رد النموذج النهائي هو رسالة الزبون** — يُسلَّم عبر outbox 'agent.reply' بترانزاكشن
//   مستقلة (D6: نداء الشبكة خارج أي ترانزاكشن؛ الإرسال الفعلي بمستهلك الإشعارات R-11).
// - نداء LLM **خارج** أي ترانزاكشن قاعدة دائماً.

export const MAX_ROUNDS = 5;
const MAX_TOKENS_PER_ROUND = 1024;

/** أسعار التوكنات بالسنتات لكل مليون توكن — أعداد صحيحة (D5). قابلة للتهيئة لكل نشر. */
export interface TokenRates {
  inSenPerMTok: bigint;
  outSenPerMTok: bigint;
}
export const DEFAULT_TOKEN_RATES: TokenRates = { inSenPerMTok: 500n, outSenPerMTok: 2_500n };

/** كلفة جولة بالسنتات — قسمة سقفية bigint (لا float): ceil((in*rIn + out*rOut) / 1e6). */
export function roundCostSen(usage: LlmUsage, rates: TokenRates): bigint {
  const raw = BigInt(usage.inputTokens) * rates.inSenPerMTok + BigInt(usage.outputTokens) * rates.outSenPerMTok;
  return (raw + 999_999n) / 1_000_000n;
}

export interface AgentDeps {
  db: Db;
  llm: LlmClient;
  rates?: TokenRates;
  now?: () => Date;
}

export interface AgentRunInput {
  tenantId: string;
  userId: string;
  conversationId: string;
  /** نص رسالة الزبون الواردة (المحرَّك يُستدعى بعد التزام حفظها بالمخزن الموحّد). */
  inboundText: string;
  /** برومبت النظام — يبنيه المستدعي (اسم النشاط، التعليمات، اللغة). */
  systemPrompt: string;
}

export type AgentOutcome =
  | { outcome: "replied"; rounds: number; text: string }
  | { outcome: "no_reply"; rounds: number } // النموذج أنهى بلا نص (نادر)
  | { outcome: "budget_exhausted"; rounds: number }
  | { outcome: "budget_missing" } // لا صف ميزانية — الوكيل معطّل للمستأجر
  | { outcome: "max_rounds"; rounds: number };

/**
 * تشغيل الوكيل على رسالة واردة واحدة. كل جولة: نداء LLM (خارج الترانزاكشنات) ← خصم
 * الكلفة ذرّياً (نفاد ⇒ توقف فوري، لا جولات إضافية) ← تنفيذ الأدوات (كلٌّ بنطاق زبون
 * المحادثة) ← أو نص نهائي ⇒ outbox 'agent.reply'.
 */
export async function runAgent(deps: AgentDeps, input: AgentRunInput): Promise<AgentOutcome> {
  const rates = deps.rates ?? DEFAULT_TOKEN_RATES;
  const now = deps.now ?? ((): Date => new Date());
  const ctx: ToolContext = { db: deps.db, tenantId: input.tenantId, userId: input.userId, conversationId: input.conversationId };

  const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: input.inboundText }] }];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const res = await deps.llm.complete({
      system: input.systemPrompt,
      messages,
      tools: TOOL_DEFS,
      maxTokens: MAX_TOKENS_PER_ROUND,
    });

    // خصم كلفة الجولة ذرّياً — بعد النداء (الكلفة الحقيقية من usage؛ تجاوز أقصاه جولة واحدة)
    const cost = roundCostSen(res.usage, rates);
    const spend = await spendAiBudget(deps.db, input.tenantId, cost, now());
    if (spend === "no_budget") return { outcome: "budget_missing" };
    if (spend === "exhausted") {
      console.warn(JSON.stringify({ action: "ai_agent", outcome: "budget_exhausted", tenantId: input.tenantId, round }));
      return { outcome: "budget_exhausted", rounds: round };
    }

    const toolUses = res.content.filter((b): b is Extract<LlmContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (res.stopReason === "tool_use" && toolUses.length > 0) {
      messages.push({ role: "assistant", content: res.content });
      const results: LlmContentBlock[] = [];
      for (const tu of toolUses) {
        const result = await executeTool(ctx, tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    // نص نهائي — رسالة الزبون: outbox بترانزاكشن مستقلة (المستهلك يرسل بقناته R-11)
    const text = res.content
      .filter((b): b is Extract<LlmContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text.length === 0) return { outcome: "no_reply", rounds: round };
    await withTenant(deps.db, input.tenantId, (tx) =>
      writeOutbox(tx, input.tenantId, "agent.reply", { userId: input.userId, text }),
    );
    return { outcome: "replied", rounds: round, text };
  }

  console.warn(JSON.stringify({ action: "ai_agent", outcome: "max_rounds", tenantId: input.tenantId }));
  return { outcome: "max_rounds", rounds: MAX_ROUNDS };
}
