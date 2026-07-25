import type { WaDeliveryMode, WaDeliveryStatus, WaTemplateKey } from "@quickdrop/shared";
import { and, desc, eq } from "drizzle-orm";
import { messages } from "./schema/conversations.js";
import { waDeliveries, whatsappTemplates, type WaDelivery } from "./schema/whatsapp-outbound.js";
import type { Tx } from "./with-tenant.js";

// ——— Task A (D1) — منطق نافذة واتساب + قوالب HSM + exactly-once. كله يعمل داخل withTenant
// (RLS يفرض المستأجر). لا أثر شبكي هنا (Meta call يبقى خارج المعاملة — D6). ———

/**
 * آخر رسالة زبون واردة عبر **واتساب** لهذه المحادثة (مصدر نافذة الـ24 ساعة). خاص بالقناة
 * عمداً (لا نستعمل conversations.last_inbound_at لأنه channel-agnostic). يقرأ من مصدر
 * الحقيقة `messages`؛ الفهرس messages_conversation_created_idx يدعم الترتيب. null = لم
 * يراسل عبر واتساب قطّ → خارج النافذة.
 */
export async function getLastWhatsAppInboundAt(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<Date | null> {
  const rows = await tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "in"),
        eq(messages.channel, "whatsapp"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

export interface ApprovedTemplate {
  metaTemplateName: string;
  language: string;
  variableMap: string[];
}

/** قالب HSM **معتمد** لهذا المفتاح/المستأجر (null = لا قالب معتمد → degraded). */
export async function getApprovedTemplate(
  tx: Tx,
  tenantId: string,
  internalKey: WaTemplateKey,
): Promise<ApprovedTemplate | null> {
  const rows = await tx
    .select({
      metaTemplateName: whatsappTemplates.metaTemplateName,
      language: whatsappTemplates.language,
      variableMap: whatsappTemplates.variableMap,
    })
    .from(whatsappTemplates)
    .where(
      and(
        eq(whatsappTemplates.tenantId, tenantId),
        eq(whatsappTemplates.internalKey, internalKey),
        eq(whatsappTemplates.status, "approved"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // حدّ DB→app (D9): variable_map مُعلَن string[] لكن jsonb يقبل أي شكل (قد يُدرَج يدوياً بخطأ
  // مثل '"code"'::jsonb بدل '["code"]'). شكل فاسد = لا قالب صالح → null → degrade مرئي، بدل
  // أن يرمي .map() لاحقاً TypeError يُصنَّف خطأً كغموض شبكي فيُعلَّم 'sent' (إسقاط صامت — D7).
  const vm = row.variableMap;
  if (!Array.isArray(vm) || !vm.every((v) => typeof v === "string")) {
    console.warn(JSON.stringify({ action: "wa_template_variable_map_malformed", tenantId, internalKey }));
    return null;
  }
  return { metaTemplateName: row.metaTemplateName, language: row.language, variableMap: vm };
}

export interface WaDeliveryClaim {
  mode: WaDeliveryMode;
  status: WaDeliveryStatus;
  internalKey?: WaTemplateKey | null;
  reason?: string | null;
}

/**
 * ادّعاء exactly-once على صفّ الـoutbox: INSERT ... ON CONFLICT (tenant, outbox_id) DO
 * NOTHING. `won=true` إن ربحنا الادّعاء (نتابع)، و`won=false` مع الصفّ الموجود إن تكفّلت
 * محاولة سابقة (نفحص status: sent/degraded → نتخطّى). المفتاح = (tenant_id, outbox_id).
 */
export async function claimWaDelivery(
  tx: Tx,
  tenantId: string,
  outboxId: string,
  init: WaDeliveryClaim,
): Promise<{ won: boolean; existing: WaDelivery | null }> {
  const inserted = await tx
    .insert(waDeliveries)
    .values({
      tenantId,
      outboxId,
      mode: init.mode,
      status: init.status,
      internalKey: init.internalKey ?? null,
      reason: init.reason ?? null,
    })
    .onConflictDoNothing({ target: [waDeliveries.tenantId, waDeliveries.outboxId] })
    .returning({ id: waDeliveries.id });
  if (inserted[0]) return { won: true, existing: null };
  const existing = await tx
    .select()
    .from(waDeliveries)
    .where(and(eq(waDeliveries.tenantId, tenantId), eq(waDeliveries.outboxId, outboxId)))
    .limit(1);
  return { won: false, existing: existing[0] ?? null };
}

/** إنهاء الادّعاء نجاحاً: status='sent' (+ wamid). لا يغيّر mode (مُحدَّد وقت الادّعاء). */
export async function finalizeWaDeliverySent(
  tx: Tx,
  tenantId: string,
  outboxId: string,
  metaMessageId: string | null,
): Promise<void> {
  await tx
    .update(waDeliveries)
    .set({ status: "sent", metaMessageId, updatedAt: new Date() })
    .where(and(eq(waDeliveries.tenantId, tenantId), eq(waDeliveries.outboxId, outboxId)));
}

/**
 * تحرير الادّعاء عند فشل **مؤكَّد** (Meta ردّت خطأً = لم تُرسِل) كي تعيد المحاولة اللاحقة
 * الإرسال (at-least-once لفشل مؤكَّد — لا شحن مزدوج لأن Meta لم ترسل). لا يُستعمل مع
 * الغموض الشبكي (هناك نُنهي 'sent' — at-most-once).
 */
export async function releaseWaDelivery(tx: Tx, tenantId: string, outboxId: string): Promise<void> {
  await tx
    .delete(waDeliveries)
    .where(and(eq(waDeliveries.tenantId, tenantId), eq(waDeliveries.outboxId, outboxId)));
}

/**
 * تحويل ادّعاء قائم إلى **degraded** لخطأ إعداد **دائم** (مثل عدم تطابق متغيّرات القالب): الإعادة
 * لن تصلحه، فنسجّله degraded مرئياً بدل عاصفة إعادة حتى DLQ. status='degraded', mode='degraded'.
 * (يختلف عن releaseWaDelivery المخصّص للفشل المؤقّت القابل لإعادة الإرسال بأمان.)
 */
export async function markWaDeliveryDegraded(tx: Tx, tenantId: string, outboxId: string, reason: string): Promise<void> {
  await tx
    .update(waDeliveries)
    .set({ status: "degraded", mode: "degraded", reason, updatedAt: new Date() })
    .where(and(eq(waDeliveries.tenantId, tenantId), eq(waDeliveries.outboxId, outboxId)));
}
