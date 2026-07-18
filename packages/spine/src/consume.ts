import { SPINE_TOPIC_SCHEMAS, isSpineTopic, type SpinePayload, type SpineTopic } from "./topics.js";

// §1 (الوثيقة) — التحقق عند الاستهلاك لا عند الإنتاج فقط: الطوابير at-least-once
// والحمولة عبرت حدود عملية (worker) — كل مستهلك يبدأ من هنا.

export type SpineEvent = {
  [T in SpineTopic]: { topic: T; payload: SpinePayload<T> };
}[SpineTopic];

export type ParseSpineResult =
  | { ok: true; event: SpineEvent }
  | { ok: false; reason: "unknown_topic" | "invalid_payload"; detail?: string };

/**
 * يفكّ حدث spine من صف outbox (topic + payload jsonb). موضوع مجهول أو حمولة فاسدة
 * = نتيجة صريحة (لا رمي) — المستهلك يقرر: تجاهل الموضوع الغريب (مواضيع إشعارات
 * قديمة تمر بنفس الـ outbox) أو معاملة الحمولة الفاسدة كفشل يذهب للمحاسبة (R-16).
 */
export function parseSpineEvent(topic: string, payload: unknown): ParseSpineResult {
  if (!isSpineTopic(topic)) {
    return { ok: false, reason: "unknown_topic" };
  }
  const parsed = SPINE_TOPIC_SCHEMAS[topic].safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_payload", detail: parsed.error.message };
  }
  return { ok: true, event: { topic, payload: parsed.data } as SpineEvent };
}
