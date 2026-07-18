import { z } from "zod";

// D8 / MERGE_PLAN §4.6 — العمود الفقري للأحداث (Event Spine): الدماغان (استقبال WA/CRM
// مقابل الإسناد الميداني) يتكاملان عبر هذه المواضيع حصراً — لا نداء مباشراً بينهما أبداً.
// كل payload له Zod schema يُتحقق منه عند النشر (publishSpineEvent) **وعند الاستهلاك**
// (parseSpineEvent) — القاعدة: التحقق عند الاستهلاك لا عند الإنتاج فقط (§1 الوثيقة).
// tenantId ليس بالـ payload — يعيش على صف الـ outbox نفسه (writeOutbox).
//
// ملاحظة نشر (adversary #7): توسيع أي enum هنا يُنشر بالتطبيقات المستهلكة (worker)
// **قبل** أول منتج يكتب القيمة الجديدة — وإلا رفض Zod عند الاستهلاك = حلقة إعادة.

const uuid = z.string().uuid();

/** حمولات المواضيع — المفتاح هو اسم الموضوع كما يُكتب بعمود outbox.topic. */
export const SPINE_TOPIC_SCHEMAS = {
  // دورة حياة الطلب (ينتجها دماغ الاستقبال أو آلة الحالة)
  "order.created": z.object({ orderId: uuid, service: z.string(), source: z.string().optional() }),
  "order.confirmed": z.object({ orderId: uuid }),
  // ⚡ حدث المفصل (THE seam): يُنشر مرة واحدة حصراً عبر ختم write-once
  // (orders.dispatch_requested_at — MERGE_PLAN §4.1/D-M1)؛ مستهلكه الوحيد dispatch.
  "order.ready_for_dispatch": z.object({ orderId: uuid }),
  "order.delivered": z.object({ orderId: uuid }),
  "order.cancelled": z.object({ orderId: uuid, reason: z.string().optional() }),

  // الدفع (Billplz — ضمن النطاق بقرار المالك 2026-07-18): عمود لا حالة (§4.2.5)
  "payment.paid": z.object({ orderId: uuid, paymentRef: z.string().min(1) }),

  // قناة واتساب (يكتبها مستهلك inbox بعد الحفظ الدائم — Phase 2/3)
  "wa.message.received": z.object({
    waMessageId: z.string().min(1),
    conversationId: uuid.optional(),
    userId: uuid.optional(),
  }),

  // دماغ الزبون (CRM) — مدخلات إعادة الحساب وjourneys
  "contact.created": z.object({ userId: uuid, channel: z.enum(["whatsapp", "telegram", "phone"]) }),
  "crm.lifecycle_changed": z.object({
    userId: uuid,
    from: z.string(),
    to: z.string(),
  }),
  "csat.submitted": z.object({ conversationId: uuid, rating: z.number().int().min(1).max(5) }),
} as const;

export type SpineTopic = keyof typeof SPINE_TOPIC_SCHEMAS;
export type SpinePayload<T extends SpineTopic> = z.infer<(typeof SPINE_TOPIC_SCHEMAS)[T]>;

export const SPINE_TOPICS = Object.keys(SPINE_TOPIC_SCHEMAS) as SpineTopic[];

export function isSpineTopic(topic: string): topic is SpineTopic {
  return topic in SPINE_TOPIC_SCHEMAS;
}
