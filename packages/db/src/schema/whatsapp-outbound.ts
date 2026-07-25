import {
  WA_DELIVERY_MODES,
  WA_DELIVERY_STATUSES,
  WA_TEMPLATE_KEYS,
  WA_TEMPLATE_STATUSES,
} from "@quickdrop/shared";
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, idPk, tenantId, timestamptz, updatedAt } from "./_common.js";

// ——— Task A (D1) — نافذة واتساب 24 ساعة + قوالب HSM (additive عند حدّ الإرسال الصادر) ———
//
// جدولان مُقيَّدان بالمستأجر (FORCE RLS):
//  1) whatsapp_templates — ربط مفتاح إشعار داخلي → قالب Meta معتمد (لا نص قالب هنا؛
//     النصوص تُسجَّل عند Meta). للإرسال خارج نافذة الـ24 ساعة.
//  2) wa_deliveries — سجلّ تسليم لكل صفّ outbox: مفتاح exactly-once (unique tenant+outbox)
//     + سجلّ النتيجة المرئي (sent/degraded) بدل الإسقاط الصامت. لا FK إلى outbox عمداً:
//     صفوف الـoutbox تُنظَّف (housekeeping)، وهذا السجلّ يعيش أطول منها كأثر تدقيق.

export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: idPk(),
    tenantId: tenantId(),
    /** المفتاح الداخلي للإشعار (WA_TEMPLATE_KEYS). */
    internalKey: text("internal_key", { enum: WA_TEMPLATE_KEYS }).notNull(),
    /** اسم القالب كما هو مُسجَّل ومعتمد عند Meta. */
    metaTemplateName: text("meta_template_name").notNull(),
    /** رمز لغة القالب عند Meta (مثل "en" / "ms"). */
    language: text("language").notNull(),
    /** حالة الاعتماد لدى Meta — لا نرسل إلا approved. */
    status: text("status", { enum: WA_TEMPLATE_STATUSES }).notNull().default("pending"),
    /** ترتيب أسماء متغيّرات جسم القالب — يجب أن يطابق ما يوفّره المُرسِل (عدداً وترتيباً). */
    variableMap: jsonb("variable_map").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("whatsapp_templates_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة (§2.3)
    uniqueIndex("whatsapp_templates_tenant_key_uq").on(t.tenantId, t.internalKey), // قالب واحد لكل مفتاح/مستأجر
  ],
);

export const waDeliveries = pgTable(
  "wa_deliveries",
  {
    id: idPk(),
    tenantId: tenantId(),
    /** صفّ الـoutbox الذي هذا التسليم عنه — مفتاح dedup exactly-once (نصّ: مفتاح ترابط لا FK،
     *  متّسق مع external_id/event_key؛ في الإنتاج هو دائماً outbox.id). */
    outboxId: text("outbox_id").notNull(),
    /** مفتاح القالب إن كان notification (null للردّ الحرّ service_reply). */
    internalKey: text("internal_key", { enum: WA_TEMPLATE_KEYS }),
    /** كيف أُرسِل: حرّ / قالب / أو تعذّر (degraded). */
    mode: text("mode", { enum: WA_DELIVERY_MODES }).notNull(),
    /** طور الادّعاء/النتيجة: claimed (مُدّعى، جارٍ) → sent (نجح) / degraded (لا قالب). */
    status: text("status", { enum: WA_DELIVERY_STATUSES }).notNull(),
    /** معرّف رسالة Meta (wamid) عند النجاح. */
    metaMessageId: text("meta_message_id"),
    /** سبب التعذّر (مثل no_approved_template:order_dispatched). */
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("wa_deliveries_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة (§2.3)
    uniqueIndex("wa_deliveries_tenant_outbox_uq").on(t.tenantId, t.outboxId), // مفتاح exactly-once
  ],
);

export type WhatsappTemplate = typeof whatsappTemplates.$inferSelect;
export type NewWhatsappTemplate = typeof whatsappTemplates.$inferInsert;
export type WaDelivery = typeof waDeliveries.$inferSelect;
export type NewWaDelivery = typeof waDeliveries.$inferInsert;
