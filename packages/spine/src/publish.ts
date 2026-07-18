import { writeOutbox, type Tx } from "@quickdrop/db";
import { SPINE_TOPIC_SCHEMAS, type SpinePayload, type SpineTopic } from "./topics.js";

// D9 — النشر = صف outbox بنفس ترانزاكشن الحدث حصراً (writeOutbox). هذه الطبقة تضيف:
// (1) أمان أنواع: الموضوع والحمولة مقيّدان ببعضهما وقت الترجمة؛
// (2) تحقق Zod وقت التشغيل قبل الكتابة — حمولة فاسدة تفشل داخل الترانزاكشن (rollback
//     نظيف) بدل أن تتسمم بالـ outbox وتُرفض عند كل استهلاك (R-16).

export async function publishSpineEvent<T extends SpineTopic>(
  tx: Tx,
  tenantId: string,
  topic: T,
  payload: SpinePayload<T>,
): Promise<{ id: string }> {
  const parsed = SPINE_TOPIC_SCHEMAS[topic].safeParse(payload);
  if (!parsed.success) {
    // §16.12 — فشل صاخب داخل الترانزاكشن: باغ منتِج، لا يُدفن صفاً فاسداً
    throw new Error(`publishSpineEvent: invalid payload for "${topic}": ${parsed.error.message}`);
  }
  return writeOutbox(tx, tenantId, topic, parsed.data as Record<string, unknown>);
}
