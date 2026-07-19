import { runAgent, AnthropicClient, type LlmClient } from "@quickdrop/ai";
import { tenants, type Db } from "@quickdrop/db";
import { eq } from "drizzle-orm";
import type { AgentTrigger } from "./wa-update-processor.js";

// §3.2 — منفّذ الوكيل بالـ worker: يُستدعى بعد التزام معالجة رسالة WA الواردة.
// حد معدل لكل (مستأجر، زبون) بنمط 5/h للـ miniapp (هنا 30/h — محادثة لا طلبات)؛
// بلا مفتاح LLM = معطّل بصوت هادئ (لوغ) — لا فشل إقلاع (الوكيل ميزة اختيارية).

export const AGENT_RATE_LIMIT_PER_HOUR = 30;

export interface AgentRateRedis {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
}

/** مفتاح حد الوكيل بدلو الساعة — INCR ذرّي + TTL بأول عدّة. */
export function agentRateKey(tenantId: string, userId: string, now = new Date()): string {
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  return `ai:rl:${tenantId}:${userId}:${hourBucket}`;
}

export interface AgentInvokerDeps {
  appDb: Db;
  scanDb: Db;
  redis: AgentRateRedis;
  /** غيابه = الوكيل معطّل منصةً (لوغ عند أول إطلاق). */
  llm: LlmClient | null;
  now?: () => Date;
}

/** يبني منفّذ onAgentTrigger — يمرَّر لـ processWaUpdate (يُستدعى بعد الالتزام). */
export function createAgentInvoker(deps: AgentInvokerDeps): (trigger: AgentTrigger) => Promise<void> {
  return async (trigger) => {
    if (!deps.llm) {
      console.log(JSON.stringify({ action: "ai_agent", outcome: "disabled_no_key", tenant_id: trigger.tenantId }));
      return;
    }
    const now = (deps.now ?? (() => new Date()))();

    // حد المعدل (§3.2): INCR ذرّي بدلو الساعة — أول عدّة تضبط TTL
    const key = agentRateKey(trigger.tenantId, trigger.userId, now);
    const count = await deps.redis.incr(key);
    if (count === 1) await deps.redis.expire(key, 3_600);
    if (count > AGENT_RATE_LIMIT_PER_HOUR) {
      console.warn(JSON.stringify({ action: "ai_agent", outcome: "rate_limited", tenant_id: trigger.tenantId, user_id: trigger.userId }));
      return;
    }

    // برومبت النظام: اسم النشاط (tenants — استثناء RLS مسمّى عبر scanDb)
    const tRows = await deps.scanDb.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, trigger.tenantId)).limit(1);
    const businessName = tRows[0]?.name ?? "المطعم";
    const systemPrompt =
      `أنت وكيل خدمة زبائن لـ«${businessName}» على واتساب. مهمتك: مساعدة الزبون بالطلب من المنيو، ` +
      `الإجابة عن حالة طلبه، وحفظ تفضيلاته. استخدم get_menu قبل أي إنشاء طلب، ولا تؤكد طلباً قبل موافقة الزبون الصريحة. ` +
      `الأسعار يحسبها النظام حصراً — لا تعد بأسعار من عندك. للتوصيل اطلب مشاركة الموقع إن لم يكن محفوظاً. ` +
      `رد بلغة الزبون (عربي/ملايو/إنكليزي) وباختصار مناسب للواتساب.`;

    const result = await runAgent(
      { db: deps.appDb, llm: deps.llm },
      {
        tenantId: trigger.tenantId,
        userId: trigger.userId,
        conversationId: trigger.conversationId,
        inboundText: trigger.text,
        systemPrompt,
      },
    );
    console.log(
      JSON.stringify({ action: "ai_agent", outcome: result.outcome, tenant_id: trigger.tenantId, conversation_id: trigger.conversationId }),
    );
  };
}

/** عميل LLM من البيئة — null إن غاب المفتاح (الوكيل معطّل). */
export function llmFromEnv(env: { ANTHROPIC_API_KEY?: string | undefined; AI_MODEL?: string | undefined }): LlmClient | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, ...(env.AI_MODEL !== undefined ? { model: env.AI_MODEL } : {}) });
}
