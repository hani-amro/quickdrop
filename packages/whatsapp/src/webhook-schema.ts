import { z } from "zod";

// D9/§11 — Zod عند الحدود بدل أنواع TS الرخوة (WaFlow كان يعرّف types ولا يتحقق منها
// وقت التشغيل). passthrough متعمد: Meta يضيف حقولاً باستمرار — نتحقق مما نستهلكه
// ونمرّر الباقي كما هو إلى payload الـ inbox (المعالجة اللاحقة تتحقق من جديد §1).

export const waMessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().regex(/^\d{7,15}$/), // wa id — أرقام فقط (نفس تحقق WaFlow المجرّب)
    timestamp: z.string().optional(),
    type: z.string(),
  })
  .passthrough();

export const waStatusSchema = z
  .object({
    id: z.string().min(1), // wamid للرسالة الصادرة
    status: z.enum(["sent", "delivered", "read", "failed"]),
    timestamp: z.string().optional(),
    recipient_id: z.string().optional(),
    errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export const waChangeValueSchema = z
  .object({
    messaging_product: z.literal("whatsapp").optional(),
    metadata: z.object({ phone_number_id: z.string().min(1), display_phone_number: z.string().optional() }).passthrough(),
    messages: z.array(waMessageSchema).optional(),
    statuses: z.array(waStatusSchema).optional(),
    contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
  })
  .passthrough();

export const waWebhookSchema = z
  .object({
    object: z.string(), // "whatsapp_business_account"
    entry: z.array(
      z
        .object({
          id: z.string().optional(),
          changes: z.array(
            z
              .object({
                field: z.string(), // نفحصه فعلياً (WaFlow لم يفحص field قط — قيم غير messages كانت تُعالج خطأً)
                value: z.unknown(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type WaMessage = z.infer<typeof waMessageSchema>;
export type WaStatus = z.infer<typeof waStatusSchema>;
export type WaChangeValue = z.infer<typeof waChangeValueSchema>;
export type WaWebhookPayload = z.infer<typeof waWebhookSchema>;

/**
 * مفاتيح إزالة التكرار لصفوف inbox — Meta يعيد الإرسال عند التأخير/غير-200 (R-12):
 * رسالة = wamid نفسه؛ حدث حالة = status:{wamid}:{status} (نفس الرسالة قد تمر بعدة حالات).
 */
export function eventKeysForValue(value: WaChangeValue): string[] {
  const keys: string[] = [];
  for (const m of value.messages ?? []) keys.push(m.id);
  for (const s of value.statuses ?? []) keys.push(`status:${s.id}:${s.status}`);
  return keys;
}
