import { tenants, webhookUpdates, withTenant, type Db } from "@quickdrop/db";
import type { TgUpdateJob } from "@quickdrop/shared";
import { decryptBotToken, getBotForTenant, registerCustomerFlow, type Bot, type ConvRedis } from "@quickdrop/telegram";
import { and, eq } from "drizzle-orm";

// §4.1(3-5) — معالجة تحديث من الـ inbox: اقرأ الصف (idempotent) ← فك تشفير توكن
// المستأجر ← bot من الـ LRU ← handleUpdate ← علّم processed.
// D9: نداءات تيليغرام (handleUpdate) خارج أي ترانزاكشن قاعدة — لذلك القراءة والتعليم
// ترانزاكشنان منفصلان حول النداء، والـ idempotency من فحص status (الفخ 7).

type TgUpdate = Parameters<Bot["handleUpdate"]>[0];

export interface UpdateProcessorDeps {
  /** كتابات/قراءات ضمن مستأجر — داخل withTenant حصراً (§2.3). */
  appDb: Db;
  /** قراءة صف المستأجر نفسه (جدول tenants — استثناء RLS مسمّى §2.3). */
  scanDb: Db;
  /** حالة المحادثة (§4.4) — ioredis يطابق ConvRedis بنيوياً. */
  redis: ConvRedis;
  /** §4.2: MASTER_KEY (32 بايت) لفك تشفير bot_token_encrypted. */
  masterKey: Buffer;
}

async function markProcessed(deps: UpdateProcessorDeps, tenantId: string, rowId: string): Promise<void> {
  await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .update(webhookUpdates)
      .set({ status: "processed" })
      .where(and(eq(webhookUpdates.id, rowId), eq(webhookUpdates.status, "received"))),
  );
}

export async function processUpdate(deps: UpdateProcessorDeps, job: TgUpdateJob): Promise<void> {
  // 1) صف الـ inbox — idempotent (الفخ 7: "ماذا لو نُفّذت مرتين؟")
  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: webhookUpdates.id, status: webhookUpdates.status, payload: webhookUpdates.payload })
      .from(webhookUpdates)
      .where(eq(webhookUpdates.updateId, job.updateId))
      .limit(1);
    return rows[0];
  });
  if (!row || row.status === "processed") return;

  // 2) المستأجر + فك تشفير التوكن (MASTER_KEY — §4.2). التوكن لا يظهر بأي لوغ/خطأ.
  const tenantRows = await deps.scanDb
    .select({
      id: tenants.id,
      status: tenants.status,
      currency: tenants.currency,
      botTokenEncrypted: tenants.botTokenEncrypted,
    })
    .from(tenants)
    .where(eq(tenants.id, job.tenantId))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) {
    // §16.12: لا ابتلاع — مستأجر مجهول لصف inbox قائم حالة تستحق DLQ وتنبيهاً، لا تجاهلاً
    throw new Error(`processUpdate: tenant ${job.tenantId} not found`);
  }

  if (tenant.status === "suspended" || tenant.status === "churned") {
    // §4.1(1): البوابة توقف المعلّقين قبل الإدراج — صف قديم سبق التعليق يُعلَّم بلا معالجة
    console.log(JSON.stringify({ action: "update_skipped_tenant_inactive", tenantId: job.tenantId, updateId: job.updateId }));
    await markProcessed(deps, job.tenantId, row.id);
    return;
  }

  if (!tenant.botTokenEncrypted) {
    throw new Error(`processUpdate: tenant ${job.tenantId} has no bot token configured`);
  }
  const token = decryptBotToken(tenant.botTokenEncrypted, deps.masterKey);

  // 3) bot من الـ LRU (§4.1-4) — bot.init() مرة واحدة، وتسجيل تدفق الزبون عند الإنشاء الأول
  const bot = await getBotForTenant({
    tenantId: job.tenantId,
    token,
    onCreate: (created) =>
      registerCustomerFlow(created, {
        db: deps.appDb,
        redis: deps.redis,
        tenantId: job.tenantId,
        currency: tenant.currency,
      }),
  });

  // 4) D9: handleUpdate (يرسل رسائل تيليغرام) خارج أي ترانزاكشن قاعدة بيانات
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null || typeof (payload as { update_id?: unknown }).update_id !== "number") {
    // §11: البوابة تتحقق بـ Zod قبل التخزين — صف مشوّه هنا فساد بيانات يستحق فشلاً صاخباً
    throw new Error(`processUpdate: malformed stored payload for update ${job.tenantId}:${job.updateId}`);
  }
  await bot.handleUpdate(payload as TgUpdate);

  // 5) علّم processed — إن انهرنا قبلها يُعاد من rescanPending/الطابور، وأخطاء المعالجات
  // نفسها عولجت صراحةً داخل التدفق/bot.catch (§16.12) فلا تصل إلى هنا.
  await markProcessed(deps, job.tenantId, row.id);
}
