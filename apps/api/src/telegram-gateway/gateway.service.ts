import { Inject, Injectable } from "@nestjs/common";
import { tenants, webhookUpdates, withTenant, type DbHandle } from "@quickdrop/db";
import { decryptSecret, secretsEqual, tgUpdateJobId, type TgUpdateJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, ENV, TG_QUEUE } from "../app.module.js";
import type { ApiEnv } from "../env.js";

// §4.1 — بوابة inbox: التحديث durable قبل الرد 200، والمعالجة عند الـ worker.
const updateSchema = z.object({ update_id: z.number().int() }).passthrough();

export type GatewayResult =
  | { outcome: "accepted" }
  | { outcome: "duplicate" }
  | { outcome: "dropped" }; // مستأجر غير موجود/موقوف أو سر خاطئ — 200 فارغ دائماً

@Injectable()
export class TelegramGatewayService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(TG_QUEUE) private readonly queue: Queue,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async ingest(tenantSlug: string, secretHeader: string | undefined, body: unknown): Promise<GatewayResult> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return { outcome: "dropped" };

    const tenant = await this.handle.db
      .select({
        id: tenants.id,
        status: tenants.status,
        webhookSecret: tenants.botWebhookSecret,
        webhookSecretEnc: tenants.botWebhookSecretEnc,
      })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);

    const found = tenant[0];
    if (!found) return { outcome: "dropped" };
    // ترحيل 0013 — dual-read انتقالي: المشفّر أولاً ثم النصي القديم حتى اكتمال الـ backfill
    const webhookSecret =
      found.webhookSecretEnc !== null
        ? decryptSecret(found.webhookSecretEnc, Buffer.from(this.env.MASTER_KEY, "hex"))
        : found.webhookSecret;
    if (!webhookSecret) return { outcome: "dropped" };
    if (!secretHeader || !secretsEqual(secretHeader, webhookSecret)) return { outcome: "dropped" };
    if (found.status === "suspended" || found.status === "churned") {
      // §4.1/§14: رسالة الاعتذار المهذبة بمعدل محدود تُضاف مع طبقة البوتات بالمرحلة 1
      return { outcome: "dropped" };
    }

    const updateId = parsed.data.update_id;
    const inserted = await withTenant(this.handle.db, found.id, (tx) =>
      tx
        .insert(webhookUpdates)
        .values({ tenantId: found.id, updateId, payload: parsed.data })
        .onConflictDoNothing()
        .returning({ id: webhookUpdates.id }),
    );

    if (inserted.length === 0) {
      // صف موجود: إذا received فهذا crash سابق — أعد الطابور، لا تتجاهل (§4.1 خطوة 3)
      const existing = await withTenant(this.handle.db, found.id, (tx) =>
        tx
          .select({ status: webhookUpdates.status })
          .from(webhookUpdates)
          .where(sql`${webhookUpdates.updateId} = ${updateId}`)
          .limit(1),
      );
      if (existing[0]?.status === "processed") return { outcome: "duplicate" };
    }

    const job: TgUpdateJob = { tenantId: found.id, updateId };
    await this.queue.add("process-update", job, {
      // tgUpdateJobId — مصدر واحد مع rescan الـ worker؛ BullMQ يرفض ':' بالـ jobId
      jobId: tgUpdateJobId(found.id, updateId),
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { count: 1000 },
    });
    return inserted.length === 0 ? { outcome: "duplicate" } : { outcome: "accepted" };
  }
}
