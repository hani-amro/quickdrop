import { WEBHOOK_UPDATE_STATUSES } from "@quickdrop/shared";
import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { bytea, createdAt, idPk, tenantId, timestamptz, updatedAt } from "./_common.js";

// ——— دمج WaFlow (MERGE_PLAN §4.5) — قناة واتساب Cloud API ———
//
// التوجيه قبل معرفة المستأجر (phone_number_id → tenant) يعيش على جدول tenants
// (استثناء الـ RLS المخصص للتوجيه — نفس سابقة slug للتيليغرام، ترحيل 0014).
// هنا فقط الأسرار والإعدادات: تحت FORCE RLS كاملاً، والتوكن مشفّر AES-256-GCM
// بمغلّف MASTER_KEY (iv|tag|ct) — لا نص صريح أبداً (درس WaFlow R-21: الـ fallback
// الصامت للنص الصريح هو ما سرّب توكنات Meta الحية).

export const waAccounts = pgTable(
  "wa_accounts",
  {
    id: idPk(),
    tenantId: tenantId(),
    /** نسخة محلية من مفتاح التوجيه (المصدر الموثوق للتوجيه: tenants.wa_phone_number_id). */
    phoneNumberId: text("phone_number_id").notNull(),
    phoneNumber: text("phone_number"),
    accessTokenEnc: bytea("access_token_enc"),
    wabaId: text("waba_id"),
    /** قالب HSM المعتمد للإرسال خارج نافذة الـ 24 ساعة (حملات/إشعارات) */
    campaignTemplateName: text("campaign_template_name"),
    campaignTemplateLang: text("campaign_template_lang"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("wa_accounts_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة (§2.3)
    // حساب واحد لكل مستأجر بـ v1 (تعدد الأرقام لاحقاً برفع القيد لا بإعادة نمذجة)
    uniqueIndex("wa_accounts_tenant_uq").on(t.tenantId),
    // دفاع إضافي ضد ازدواج التوجيه (R-13): الرقم لا يخدم مستأجرين
    uniqueIndex("wa_accounts_phone_number_id_uq").on(t.phoneNumberId),
  ],
);

// §4.1 (نمط webhook_updates حرفياً) — inbox لا مجرد dedup: الحفظ durable ثم 200 ثم
// طابور؛ صف received بعد crash يُعاد للمعالجة لا يُتجاهل (R-12 — عكس WaFlow القاتل:
// ack قبل الحفظ = رسالة مفقودة للأبد لأن Meta لا يعيد بعد الـ 200).
export const waWebhookUpdates = pgTable(
  "wa_webhook_updates",
  {
    id: idPk(),
    tenantId: tenantId(),
    /**
     * مفتاح إزالة التكرار: wa message id للرسائل، أو مفتاح تركيبي محدد الشكل لأحداث
     * الحالة (status:{wamid}:{status}) — Meta يعيد الإرسال عند التأخير/غير-200.
     */
    eventKey: text("event_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: WEBHOOK_UPDATE_STATUSES }).notNull().default("received"),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wa_webhook_updates_tenant_event_uq").on(t.tenantId, t.eventKey),
    index("wa_webhook_updates_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export type WaAccount = typeof waAccounts.$inferSelect;
export type NewWaAccount = typeof waAccounts.$inferInsert;
export type WaWebhookUpdate = typeof waWebhookUpdates.$inferSelect;
export type NewWaWebhookUpdate = typeof waWebhookUpdates.$inferInsert;
