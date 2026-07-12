import {
  acceptOffer,
  driverLocations,
  drivers,
  InvalidTransitionError,
  orderAttachments,
  orders,
  rejectOffer,
  tenants,
  transition,
  webhookUpdates,
  withTenant,
  type Db,
  type Tx,
} from "@quickdrop/db";
import { makePoint, publishRt, RT_EVENTS, toPostgisWkt, type RtPublishClient, type TgUpdateJob } from "@quickdrop/shared";
import {
  ImageValidationError,
  podKey,
  validateAndReencode,
  type StorageClient,
} from "@quickdrop/storage";
import {
  computeIsSuspect,
  decryptBotToken,
  getBotForTenant,
  registerCustomerFlow,
  registerDriverFlow,
  type Bot,
  type ConvRedis,
} from "@quickdrop/telegram";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

// §4.1(3-5) — معالجة تحديث من الـ inbox: اقرأ الصف (idempotent) ← فك تشفير توكن
// المستأجر ← bot من الـ LRU ← handleUpdate ← علّم processed.
// D9: نداءات تيليغرام (handleUpdate) خارج أي ترانزاكشن قاعدة — لذلك القراءة والتعليم
// ترانزاكشنان منفصلان حول النداء، والـ idempotency من فحص status (الفخ 7).

type TgUpdate = Parameters<Bot["handleUpdate"]>[0];

/** §7 v1.1 — نصف قطر geofence الوصول بالأمتار: نقطتان متتاليتان ضمنه من نقطة التسليم → arrived. */
export const GEOFENCE_ARRIVED_RADIUS_M = 150;

/**
 * §7 v1.1 — الانتقالات التلقائية بعد كتابة نقطة **غير مشبوهة** (المشبوهة لا تغذّي
 * الـ geofence — §3)، لكل طلب من طلبات السائق النشطة على حدة (D14):
 * - picked_up → in_transit بفاعل system: أول تحديث موقع بعد الاستلام (§5 v1.1).
 * - in_transit → arrived بفاعل system: آخر نقطتين متتاليتين غير مشبوهتين كلتاهما ضمن
 *   150م من نقطة التسليم — النقطتان درعُ قفزات GPS (§7 v1.1).
 *
 * استعلام واحد يجلب الطلبات النشطة وفحص المسافة معاً بالقاعدة (ST_DWithin على
 * geography = أمتار — D7)؛ تُستدعى داخل ترانزاكشن withTenant القائمة، وtransition
 * تكتب order_events + outbox بنفس الترانزاكشن (D8) — لا نداء تيليغرام هنا (D9).
 * قفل صف السائق (recordDriverLocation) يسلسل نبضتين متزامنتين فلا تتسابقان هنا.
 */
async function applyGeofenceTransitions(tx: Tx, tenantId: string, driverId: string): Promise<void> {
  // «آخر نقطتين متتاليتين غير مشبوهتين»: count(*) = 2 يمنع التسليح بنقطة واحدة
  // (bool_and على صف واحد يمرّ)، وbool_and يشترط النقطتين معاً ضمن الدائرة.
  // subquery مرتبط بصف الطلب (dropoff_point) — يعاد تقييمه لكل طلب على حدة (D14).
  const lastTwoWithinDropoff = sql<boolean>`(
    SELECT count(*) = 2 AND bool_and(ST_DWithin(${orders.dropoffPoint}, last2.point, ${GEOFENCE_ARRIVED_RADIUS_M}::float8))
    FROM (
      SELECT dl.point
      FROM driver_locations dl
      WHERE dl.tenant_id = ${tenantId}
        AND dl.driver_id = ${driverId}
        AND dl.is_suspect = false
      ORDER BY dl.recorded_at DESC
      LIMIT 2
    ) last2
  )`;

  const activeOrders = await tx
    .select({ id: orders.id, status: orders.status, arrivedByGeofence: lastTwoWithinDropoff })
    .from(orders)
    .where(
      and(
        eq(orders.driverId, driverId),
        inArray(orders.status, ["picked_up", "in_transit"]),
        isNull(orders.deletedAt), // D10: المحذوف ناعماً خارج اللعبة
      ),
    );

  for (const order of activeOrders) {
    if (order.status === "picked_up") {
      try {
        // §5 v1.1 — أول موقع غير مشبوه بعد الاستلام → in_transit بفاعل system
        await transition(tx, {
          orderId: order.id,
          to: "in_transit",
          actor: { type: "system" },
          meta: { trigger: "driver_location" },
        });
      } catch (error: unknown) {
        // idempotent (§7): سباق مع زر «انطلقت» الاحتياطي أو انتقال متزامن — الانتقال
        // حدث سلفاً بيد غيرنا، وإعادة رميه تُفشل نبضة موقع سليمة. التجاهل الصامت
        // مسموح **في هذا الموضع حصراً** (§16.12: معالجة صريحة مبررة، لا ابتلاع أعمى).
        if (!(error instanceof InvalidTransitionError)) throw error;
      }
    } else if (order.status === "in_transit" && order.arrivedByGeofence) {
      try {
        // §7 v1.1 — نقطتان متتاليتان غير مشبوهتين ضمن 150م → arrived بفاعل system
        await transition(tx, {
          orderId: order.id,
          to: "arrived",
          actor: { type: "system" },
          meta: { trigger: "geofence" },
        });
      } catch (error: unknown) {
        // idempotent (§7): السائق يدخل ويخرج من الدائرة عدة مرات، أو زر «وصلت» سبقنا —
        // الانتقال يحدث مرة واحدة والباقي يُتجاهل. التجاهل الصامت مسموح **في هذا
        // الموضع حصراً** (§16.12: معالجة صريحة مبررة، لا ابتلاع أعمى).
        if (!(error instanceof InvalidTransitionError)) throw error;
      }
    }
  }
}

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
 * §7 v1.1 — نقطة موقع سائق (live location عبر بوت السائق):
 * INSERT driver_locations + فحص is_suspect **عند الإدخال** (§3: سرعة > 150 كم/س أو
 * قفزة > 2كم بأقل من 10 ثوان مقارنةً بآخر نقطة)، ثم تحديث drivers.last_point/last_point_at
 * **فقط إذا** recorded_at أحدث من المخزّن (التحديثات تصل خارج الترتيب — لا ترتدّ بالنقطة
 * للخلف) **وليست** مشبوهة. كله ترانزاكشن withTenant واحدة — D9: لا نداء تيليغرام هنا.
 */
export async function recordDriverLocation(
  deps: UpdateProcessorDeps,
  tenantId: string,
  driverId: string,
  point: { lat: number; lng: number },
  recordedAt: Date,
): Promise<void> {
  const suspect = await withTenant(deps.appDb, tenantId, async (tx) => {
    // §16.11 — قراءة-ثم-كتابة على drivers.last_point/last_point_at: قفل صف السائق؛
    // يسلسل أيضاً نبضتين متزامنتين لنفس السائق فلا تتسابقان على «آخر نقطة».
    const lockedRows = await tx
      .select({ id: drivers.id, lastPointAt: drivers.lastPointAt })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .for("update");
    const driver = lockedRows[0];
    if (!driver) {
      throw new Error(`recordDriverLocation: driver ${driverId} not found`); // §16.12: فشل صاخب
    }

    // آخر نقطة مسجّلة للمقارنة — القراءة الهندسية بـ SQL صريح (ST_X/ST_Y)، لا WKB خام عبر الـ ORM
    const prevRows = await tx
      .select({
        lat: sql<number>`ST_Y(${driverLocations.point}::geometry)`,
        lng: sql<number>`ST_X(${driverLocations.point}::geometry)`,
        recordedAt: driverLocations.recordedAt,
      })
      .from(driverLocations)
      .where(eq(driverLocations.driverId, driverId))
      .orderBy(desc(driverLocations.recordedAt))
      .limit(1);
    const prev = prevRows[0] ?? null;

    // §3 — منطق صافٍ مُختبَر بـ @quickdrop/telegram: المشبوهة تُخزَّن وتُنبِّه فقط، لا رفض صامت
    const { isSuspect, speedKmh } = computeIsSuspect(prev, { lat: point.lat, lng: point.lng, recordedAt });

    const wkt = toPostgisWkt(makePoint(point.lat, point.lng)); // الفخ 6/D7: WKT بترتيب lng lat
    await tx.insert(driverLocations).values({ tenantId, driverId, point: wkt, recordedAt, speedKmh, isSuspect });

    // §7 v1.1 — last_point فقط إذا أحدث وغير مشبوهة (المشبوهة لا تُغذّي geofence ولا last_point §3)
    if (!isSuspect && (driver.lastPointAt === null || recordedAt.getTime() > driver.lastPointAt.getTime())) {
      await tx
        .update(drivers)
        .set({ lastPoint: wkt, lastPointAt: recordedAt, updatedAt: new Date() })
        .where(eq(drivers.id, driverId));
    }

    if (!isSuspect) {
      // §7 v1.1 — الانتقالات التلقائية (in_transit/arrived) بعد كتابة النقطة غير المشبوهة،
      // بنفس ترانزاكشن withTenant (transition تكتب order_events + outbox معها — D8/D9).
      await applyGeofenceTransitions(tx, tenantId, driverId);
    }
    return isSuspect;
  });

  if (suspect) {
    // §3: النقطة المشبوهة ترفع تنبيهاً للموزّع بدل الرفض الصامت — v1: لوغ منظّم (§13)؛
    // التنبيه البصري بالداشبورد يصل مع شاشة الخريطة (Socket.IO).
    console.warn(JSON.stringify({ action: "driver_location_suspect", tenantId, driverId, recordedAt: recordedAt.toISOString() }));
  } else {
    // §10.1 — بعد التزام الترانزاكشن حصراً (لا بث لكتابة قد تُرجَع): نقطة غير مشبوهة
    // → حدث driver.location لغرفة لوحة المستأجر. المشبوهة لا تحرّك المؤشر — نفس
    // قاعدة last_point (§3). أفضل جهد (publishRt لا يرمي): نبضة سليمة لا تفشل بسبب البث.
    await publishRt(deps.rtRedis, {
      tenantId,
      event: RT_EVENTS.driverLocation,
      payload: { driverId, lat: point.lat, lng: point.lng, recordedAt: recordedAt.toISOString() },
    });
  }
}

// §11 v1.1 — إثبات التسليم: صورة من سائق له طلب نشط (picked_up..arrived) →
// إعادة ترميز (sharp: يقتل أي payload + يمسح EXIF، فحص magic bytes + حد 10MB داخل
// validateAndReencode) ← رفع S3 ← INSERT order_attachments. التنزيل تمّ سلفاً بمعالج
// البوت (خارج أي ترانزاكشن، D9)؛ هنا الترميز والتخزين ثم الإدراج الذرّي.
type PodPhotoResult =
  | { outcome: "stored"; publicCode: string }
  | { outcome: "no_active_order" }
  | { outcome: "rejected"; reason: string };

const POD_ACTIVE_STATUSES = ["picked_up", "in_transit", "arrived"] as const;

async function recordPodPhoto(
  deps: UpdateProcessorDeps,
  tenantId: string,
  driverId: string,
  imageBuffer: Buffer,
): Promise<PodPhotoResult> {
  if (deps.storage === null) return { outcome: "no_active_order" }; // حارس نوعي — لا يُستدعى أصلاً

  // الطلب النشط للسائق (أحدثها) — القراءة سريعة قبل عمل التخزين المكلف
  const active = await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .select({ id: orders.id, publicCode: orders.publicCode })
      .from(orders)
      .where(
        and(
          eq(orders.driverId, driverId),
          inArray(orders.status, [...POD_ACTIVE_STATUSES]),
          isNull(orders.deletedAt),
        ),
      )
      .orderBy(desc(orders.updatedAt))
      .limit(1),
  );
  const order = active[0];
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

  // الإدراج الذرّي فقط داخل withTenant (§2.3)
  await withTenant(deps.appDb, tenantId, (tx) =>
    tx.insert(orderAttachments).values({
      tenantId,
      orderId: order.id,
      kind: "pod_photo",
      objectKey: key,
      createdBy: driverId,
    }),
  );

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
    onCreate: (created) => {
      registerDriverFlow(created, {
        db: deps.appDb,
        tenantId: job.tenantId,
        // §6.2 D16 — القبول/الرفض ترانزاكشنات قاعدة بأقفال صفوف (dispatch.ts) — العقد الملزم
        acceptOffer: (offerId, driverId) => acceptOffer(deps.appDb, job.tenantId, offerId, driverId),
        rejectOffer: (offerId, driverId) => rejectOffer(deps.appDb, job.tenantId, offerId, driverId),
        onLocation: (driverId, point, recordedAt) => recordDriverLocation(deps, job.tenantId, driverId, point, recordedAt),
        // §11 — إثبات التسليم بالصورة (POD): معطّل إن لم يُهيَّأ التخزين (deps.storage=null)
        ...(deps.storage !== null
          ? { onPodPhoto: (driverId, buffer) => recordPodPhoto(deps, job.tenantId, driverId, buffer) }
          : {}),
      });
      registerCustomerFlow(created, {
        db: deps.appDb,
        redis: deps.redis,
        tenantId: job.tenantId,
        currency: tenant.currency,
      });
    },
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
