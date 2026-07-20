import {
  acceptOffer,
  findDriverActiveOrderForPod,
  insertPodAttachment,
  recordDriverLocationTx,
  rejectOffer,
  tenants,
  webhookUpdates,
  withTenant,
  type Db,
} from "@quickdrop/db";
import { publishRt, RT_EVENTS, type RtPublishClient, type TgUpdateJob } from "@quickdrop/shared";
import {
  ImageValidationError,
  podKey,
  validateAndReencode,
  type StorageClient,
} from "@quickdrop/storage";
import {
  decryptBotToken,
  getBotForTenant,
  registerCustomerFlow,
  registerDriverFlow,
  registerMerchantFlow,
  type Bot,
  type ConvRedis,
} from "@quickdrop/telegram";
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
  /** §10.1 — ناشر الوقت الحقيقي: PUBLISH على قناة RT_REDIS_CHANNEL (عملياً نفس عميل ioredis). */
  rtRedis: RtPublishClient;
  /** §11 — تخزين إثبات التسليم (S3/MinIO). null = POD معطّل (بلا S3 مُهيّأ). */
  storage: StorageClient | null;
}

/**
 * §7 v1.1 — نقطة موقع سائق (live location عبر بوت السائق): منطق is_suspect + geofence + كتابة
 * النقطة انتقل إلى @quickdrop/db (recordDriverLocationTx — مصدر واحد يشترك فيه هذا المعالج
 * وقناة السائق PWA). هنا: استدعاء ثم بثّ driver.location للنقطة غير المشبوهة بعد الالتزام (D9).
 */
export async function recordDriverLocation(
  deps: UpdateProcessorDeps,
  tenantId: string,
  driverId: string,
  point: { lat: number; lng: number },
  recordedAt: Date,
): Promise<void> {
  const { isSuspect } = await recordDriverLocationTx(deps.appDb, tenantId, driverId, point, recordedAt);
  if (isSuspect) {
    // §3: النقطة المشبوهة ترفع تنبيهاً للموزّع بدل الرفض الصامت — v1: لوغ منظّم (§13).
    console.warn(JSON.stringify({ action: "driver_location_suspect", tenantId, driverId, recordedAt: recordedAt.toISOString() }));
  } else {
    // §10.1 — بعد الالتزام حصراً: نقطة غير مشبوهة → حدث driver.location لغرفة اللوحة (أفضل جهد).
    await publishRt(deps.rtRedis, {
      tenantId,
      event: RT_EVENTS.driverLocation,
      payload: { driverId, lat: point.lat, lng: point.lng, recordedAt: recordedAt.toISOString() },
    });
  }
}

// §11 v1.1 — إثبات التسليم: صورة من سائق له طلب نشط (picked_up..arrived) → إعادة ترميز (sharp)
// ← رفع S3 ← INSERT order_attachments. مساعدتا القاعدة (البحث/الإدراج) في @quickdrop/db (مشترك
// مع driver API)؛ التخزين هنا (worker يملك StorageClient). التنزيل تمّ سلفاً بمعالج البوت (D9).
type PodPhotoResult =
  | { outcome: "stored"; publicCode: string }
  | { outcome: "no_active_order" }
  | { outcome: "rejected"; reason: string };

async function recordPodPhoto(
  deps: UpdateProcessorDeps,
  tenantId: string,
  driverId: string,
  imageBuffer: Buffer,
): Promise<PodPhotoResult> {
  if (deps.storage === null) return { outcome: "no_active_order" }; // حارس نوعي — لا يُستدعى أصلاً

  const order = await findDriverActiveOrderForPod(deps.appDb, tenantId, driverId);
  if (!order) return { outcome: "no_active_order" };

  // §11 — إعادة الترميز والفحص (magic bytes/الحجم/فك الترميز) خارج أي ترانزاكشن
  let reencoded;
  try {
    reencoded = await validateAndReencode(imageBuffer);
  } catch (error) {
    if (error instanceof ImageValidationError) return { outcome: "rejected", reason: error.reason };
    throw error; // §16.12 — غير أخطاء التحقق يُعاد رميه
  }

  const key = podKey(tenantId, order.id, "jpg");
  await deps.storage.putObject(key, reencoded.buffer, reencoded.contentType); // شبكة — خارج الترانزاكشن (D9)
  await insertPodAttachment(deps.appDb, tenantId, order.id, key, driverId);
  return { outcome: "stored", publicCode: order.publicCode };
}

async function markProcessed(deps: UpdateProcessorDeps, tenantId: string, rowId: string): Promise<void> {
  await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .update(webhookUpdates)
      .set({ status: "processed" })
      .where(and(eq(webhookUpdates.id, rowId), eq(webhookUpdates.status, "received"))),
  );
}

// §4.1(4)/§4.4 — تسجيل تدفقَي السائق ثم الزبون على bot مستأجر. مصدر واحد يستعمله
// مسارا التشغيل: webhook (processUpdate أعلاه) وlong-polling (bot-poll.ts، التطوير §4.4) —
// فالسلوك متطابق. ترتيب السائق أولاً مقصود (تعليق أدناه بـ processUpdate).
export function registerTenantFlows(
  bot: Bot,
  deps: UpdateProcessorDeps,
  tenantId: string,
  currency: string,
): void {
  registerDriverFlow(bot, {
    db: deps.appDb,
    tenantId,
    // §6.2 D16 — القبول/الرفض ترانزاكشنات قاعدة بأقفال صفوف (dispatch.ts) — العقد الملزم
    acceptOffer: (offerId, driverId) => acceptOffer(deps.appDb, tenantId, offerId, driverId),
    rejectOffer: (offerId, driverId) => rejectOffer(deps.appDb, tenantId, offerId, driverId),
    onLocation: (driverId, point, recordedAt) => recordDriverLocation(deps, tenantId, driverId, point, recordedAt),
    // §11 — إثبات التسليم بالصورة (POD): معطّل إن لم يُهيَّأ التخزين (deps.storage=null)
    ...(deps.storage !== null
      ? { onPodPhoto: (driverId, buffer) => recordPodPhoto(deps, tenantId, driverId, buffer) }
      : {}),
  });
  // §3 (بوت التاجر) — قبل تدفق الزبون: معالج /start هنا يمرّر next() لأي حمولة ليست كود
  // ربط، فيصل /start العادي للزبون. التسجيل بعده كان سيجعل /start الزبون يبتلع كود الربط.
  registerMerchantFlow(bot, { db: deps.appDb, redis: deps.redis, tenantId });
  registerCustomerFlow(bot, { db: deps.appDb, redis: deps.redis, tenantId, currency });
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

  // 3) bot من الـ LRU (§4.1-4) — bot.init() مرة واحدة، وتسجيل التدفقين عند الإنشاء الأول.
  // ترتيب التسجيل مقصود: تدفق السائق أولاً — معالجات مواقعه تمرّر next() لغير السائقين
  // فيصل موقع الزبون لتدفق إنشاء الطلب، بينما معالج مواقع الزبون لا يمرّر؛ التسجيل
  // بعده كان سيُسقط مواقع السائقين (live location — §7/الفخ 9).
  const bot = await getBotForTenant({
    tenantId: job.tenantId,
    token,
    onCreate: (created) => registerTenantFlows(created, deps, job.tenantId, tenant.currency),
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
