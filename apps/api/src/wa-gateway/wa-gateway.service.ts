import { Inject, Injectable } from "@nestjs/common";
import { tenants, waWebhookUpdates, withTenant, type DbHandle } from "@quickdrop/db";
import { waUpdateJobId, type WaUpdateJob } from "@quickdrop/shared";
import { eventKeysForValue, verifyMetaSignature, waChangeValueSchema, waWebhookSchema } from "@quickdrop/whatsapp";
import type { Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { DB, ENV, WA_QUEUE } from "../tokens.js";
import type { ApiEnv } from "../env.js";

// MERGE_PLAN §3.1 / R-12 — بوابة واتساب على نمط بوابة تيليغرام حرفياً، بعكس مسار
// WaFlow القاتل (ack قبل الحفظ = رسالة مفقودة للأبد): تحقق التوقيع على الجسم الخام
// → توجيه بالمستأجر عبر tenants.wa_phone_number_id (جدول التوجيه، سابقة slug)
// → حفظ durable بـ wa_webhook_updates (dedup بمفتاح الحدث) → 200 → طابور.
// Meta يعيد الإرسال عند غير-200/التأخير — dedup الـ inbox يمتص الإعادة (idempotent).

export interface WaGatewayResult {
  outcome: "accepted" | "invalid_signature" | "not_configured" | "dropped";
  /** عدد صفوف الـ inbox التي وصلت الطابور (جديدة + received عالقة من crash سابق) */
  enqueued: number;
}

@Injectable()
export class WaGatewayService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(WA_QUEUE) private readonly queue: Queue<WaUpdateJob>,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** GET hub.challenge — تحقق اشتراك Meta. null = رفض (403 عند الكنترولر). */
  verifySubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    if (!this.env.META_VERIFY_TOKEN) return null; // القناة غير مهيأة — معطَّلة بصوت عالٍ
    if (mode !== "subscribe" || !challenge) return null;
    if (token !== this.env.META_VERIFY_TOKEN) return null;
    return challenge;
  }

  async ingest(rawBody: Buffer | undefined, signatureHeader: string | undefined, parsedBody: unknown): Promise<WaGatewayResult> {
    if (!this.env.META_APP_SECRET) {
      // غير مهيأة: لا نعالج شيئاً — 200 كي لا يعيد Meta للأبد لو وُجّه إلينا خطأً
      return { outcome: "not_configured", enqueued: 0 };
    }
    // §11 — التوقيع على الجسم **الخام** قبل أي parsing؛ فساده = 401 (adversary R-13)
    if (!rawBody || !verifyMetaSignature(rawBody, signatureHeader, this.env.META_APP_SECRET)) {
      return { outcome: "invalid_signature", enqueued: 0 };
    }

    const parsed = waWebhookSchema.safeParse(parsedBody);
    if (!parsed.success) {
      // موقَّع لكن خارج سكيمتنا = فجوة عندنا لا هجوم — سجّل وأنهِ 200 (لا حلقة إعادة)
      console.error(JSON.stringify({ action: "wa_gateway", outcome: "schema_mismatch" }));
      return { outcome: "dropped", enqueued: 0 };
    }

    let enqueued = 0;
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        if (change.field !== "messages") continue; // template/account updates — مرحلة لاحقة
        const value = waChangeValueSchema.safeParse(change.value);
        if (!value.success) {
          console.error(JSON.stringify({ action: "wa_gateway", outcome: "value_schema_mismatch" }));
          continue;
        }
        enqueued += await this.ingestChangeValue(value.data);
      }
    }
    return { outcome: "accepted", enqueued };
  }

  private async ingestChangeValue(value: ReturnType<typeof waChangeValueSchema.parse>): Promise<number> {
    const phoneNumberId = value.metadata.phone_number_id;
    // التوجيه قبل معرفة المستأجر — جدول tenants (استثناء RLS المخصص للتوجيه، سابقة slug).
    // فريد جزئياً (0014) — لا غموض findFirst (R-13: كان يسلّم رسائل مستأجر لآخر).
    const tenantRows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.waPhoneNumberId, phoneNumberId))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant) {
      // مجهول = تهيئة ناقصة أو رقم أزيل — لوغ + 200 (لا تسريب إشارة، لا حلقة إعادة من Meta)
      console.warn(JSON.stringify({ action: "wa_gateway", outcome: "unknown_phone_number_id" }));
      return 0;
    }
    if (tenant.status === "suspended" || tenant.status === "churned") return 0;

    const keys = eventKeysForValue(value);
    if (keys.length === 0) return 0;

    // الحفظ durable أولاً (inbox) — صف لكل حدث؛ الإعادة من Meta تصطدم بالمفتاح الفريد
    const toEnqueue = await withTenant(this.handle.db, tenant.id, async (tx) => {
      const inserted = await tx
        .insert(waWebhookUpdates)
        .values(keys.map((eventKey) => ({ tenantId: tenant.id, eventKey, payload: value })))
        .onConflictDoNothing()
        .returning({ id: waWebhookUpdates.id });
      const ids = inserted.map((r) => r.id);
      if (inserted.length < keys.length) {
        // صفوف موجودة: received = crash سابق بعد الالتزام وقبل المعالجة → أعد الطابور (§4.1 خطوة 3)
        const stuck = await tx
          .select({ id: waWebhookUpdates.id })
          .from(waWebhookUpdates)
          .where(
            and(
              eq(waWebhookUpdates.tenantId, tenant.id),
              inArray(waWebhookUpdates.eventKey, keys),
              eq(waWebhookUpdates.status, "received"),
            ),
          );
        for (const row of stuck.map((r) => r.id)) {
          if (!ids.includes(row)) ids.push(row);
        }
      }
      return ids;
    });

    for (const updateId of toEnqueue) {
      const job: WaUpdateJob = { tenantId: tenant.id, updateId };
      await this.queue.add("process-wa-update", job, {
        jobId: waUpdateJobId(updateId), // بلا ':' — قيد BullMQ؛ الإعادة تُزال بالطابور
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 1000 },
      });
    }
    return toEnqueue.length;
  }
}
