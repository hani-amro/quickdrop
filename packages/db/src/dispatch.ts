import { MAX_DISPATCH_ROUNDS, OFFER_TTL_MS, type OrderStatus } from "@quickdrop/shared";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { writeOutbox } from "./outbox.js";
import { drivers, offers, orders, users, type Order } from "./schema/index.js";
import { transition } from "./state-machine.js";
import { withTenant, type Tx } from "./with-tenant.js";

// §6 v1.1 — محرك الإسناد. D16: القاعدة هي سلطة القبول الوحيدة — كل قرار قبول/انتهاء
// = ترانزاكشن بأقفال صفوف، ومفاتيح Redis/الطوابير تلميحات تسريع فقط: لا يُبنى على
// وجودها أو غيابها قرارٌ ولا رسالة مستخدم (§6.2). كل رسائل الرفض تُشتق من صفوف القاعدة.
// D9: لا نداء تيليغرام هنا إطلاقاً — البطاقات وجدولة مهام الـ timeout مسؤولية
// مستهلكي الطوابير بعد الالتزام، عبر صفوف الـ outbox المكتوبة بنفس الترانزاكشن.

/** حقن التبعيات للمستهلكين (worker) — القاعدة فقط؛ لا Redis هنا (D16). */
export interface DispatchDeps {
  db: Db;
}

/** §6.1 — مرشّح جولة: سائق online ضمن النطاق مع سعة متاحة وموقع طازج. */
export interface CandidateDriver {
  driverId: string;
  userTelegramId: number | null;
  distanceM: number;
}

/**
 * §6.1 — أنصاف الأقطار الجوية (متر) لكل جولة: تتوسع مع كل فشل
 * (round 1: 3كم → round 2: 6كم → round 3: 10كم).
 */
export const ROUND_RADII_M = [3_000, 6_000, 10_000] as const;

/**
 * §6.2 — نصف قطر الجولة. جولة فوق آخر مُعرَّف تثبت على الأوسع (لو رُفع
 * MAX_DISPATCH_ROUNDS يوماً بلا توسيع القائمة — لا انفجار، أوسع نطاق متاح).
 * جولة غير صحيحة (< 1 أو كسرية) = باغ مستدعٍ → فشل صاخب (§16.12).
 */
export function radiusForRound(round: number): number {
  if (!Number.isInteger(round) || round < 1) {
    throw new RangeError(`radiusForRound: round must be a positive integer, got ${round}`);
  }
  const last = ROUND_RADII_M[ROUND_RADII_M.length - 1];
  if (last === undefined) {
    throw new Error("radiusForRound: ROUND_RADII_M is empty"); // مستحيلة — ثابت أعلاه
  }
  return ROUND_RADII_M[round - 1] ?? last;
}

/** §6.1 — حجم دفعة الترشيح لكل جولة. */
export const MAX_CANDIDATES_PER_ROUND = 5;

/** §6.1 — أقصى عمر لآخر نقطة موقع (ثانية): أحدث من دقيقتين وإلا السائق "أعمى". */
export const LOCATION_FRESHNESS_S = 120;

/**
 * D14 — الحالات التي يُعتبر فيها الطلب "نشطاً" على السائق (يستهلك سعته):
 * assigned..arrived. الانشغال يُشتق من العدّ مقابل max_concurrent_orders — لا حالة busy.
 */
export const DRIVER_ACTIVE_ORDER_STATUSES = [
  "assigned",
  "picked_up",
  "in_transit",
  "arrived",
] as const satisfies readonly OrderStatus[];

/**
 * §6.1 — الترشيح. تُستدعى داخل ترانزاكشن مستأجر قائمة (withTenant) حصراً.
 *
 * الشروط: status='online' (وردية مفتوحة) · سعة متاحة (عدد الطلبات النشطة D14
 * < max_concurrent_orders) · آخر نقطة أحدث من دقيقتين · ضمن نصف القطر الجوي
 * للجولة (ST_DWithin على geography = أمتار). يُستبعد من لديه عرض pending أو
 * rejected لهذا الطلب بأي جولة — rejected لا يُعاد عرضه؛ expired (لم يرد أصلاً)
 * يجوز أن يعود بجولة أوسع.
 *
 * الترتيب: ST_Distance جوي تصاعدياً — الفخ 5: "أقرب سائق" جوّاً قد يكون خلف نهر؛
 * الترتيب النهائي بـ OSRM /table (طلب واحد للدفعة كلها) بالمرحلة 2.
 * cash_limit: يُتجاهل بـ v1 — فحصه يتفعل مع الدفتر الحي (§8.1) حين يصبح رصيد
 * السائق المتراكم قابلاً للاشتقاق. مطابقة المركبة/الخدمة مؤجلة معه (لا جدول ربط بعد).
 */
export async function findCandidates(tx: Tx, order: Order, round: number): Promise<CandidateDriver[]> {
  const radiusM = radiusForRound(round);

  // D14: عدّ الطلبات النشطة subquery مرتبط بصف السائق — soft delete لا يُحتسب (D10).
  const activeStatusesIn = sql.join(
    DRIVER_ACTIVE_ORDER_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const hasCapacity = sql`(
    SELECT count(*) FROM orders ao
    WHERE ao.tenant_id = ${drivers.tenantId}
      AND ao.driver_id = ${drivers.id}
      AND ao.deleted_at IS NULL
      AND ao.status IN (${activeStatusesIn})
  ) < ${drivers.maxConcurrentOrders}`;

  // §6.1: pending = جولة جارية معه أصلاً؛ rejected = رفض صريحاً فلا يُعاد إزعاجه.
  const notAlreadyOffered = sql`NOT EXISTS (
    SELECT 1 FROM offers prior
    WHERE prior.tenant_id = ${drivers.tenantId}
      AND prior.driver_id = ${drivers.id}
      AND prior.order_id = ${order.id}
      AND prior.status IN ('pending', 'rejected')
  )`;

  // D7: الهندسة تُقرأ وتُقارن بـ SQL صريح (ST_DWithin/ST_Distance على geography = أمتار)
  // — لا قراءة WKB خام عبر الـ ORM؛ نقطة الاستلام تُؤخذ من صف الطلب بالـ join.
  const distanceExpr = sql<number>`ST_Distance(${drivers.lastPoint}, ${orders.pickupPoint})`.mapWith(Number);

  const rows = await tx
    .select({
      driverId: drivers.id,
      userTelegramId: users.telegramUserId,
      distanceM: distanceExpr,
    })
    .from(drivers)
    .innerJoin(orders, eq(orders.id, order.id))
    .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
    .where(
      and(
        eq(drivers.status, "online"),
        isNotNull(drivers.lastPoint),
        sql`${drivers.lastPointAt} > now() - make_interval(secs => ${LOCATION_FRESHNESS_S}::float8)`,
        sql`ST_DWithin(${drivers.lastPoint}, ${orders.pickupPoint}, ${radiusM}::float8)`,
        hasCapacity,
        notAlreadyOffered,
      ),
    )
    .orderBy(asc(distanceExpr))
    .limit(MAX_CANDIDATES_PER_ROUND);

  return rows.map((r) => ({
    driverId: r.driverId,
    userTelegramId: r.userTelegramId,
    distanceM: Math.round(r.distanceM),
  }));
}

/**
 * §6.2 — بدء جولة: ترانزاكشن withTenant واحدة تقفل صف الطلب FOR UPDATE (§16.11)،
 * ترشّح، وتكتب صف العرض + outbox 'offer.created' ذرّياً. بطاقة السائق وجدولة
 * الـ delayed job عند expires_at مسؤولية المستهلكين بعد الالتزام (D9) —
 * مصدر الحقيقة للمهلة هو offers.expires_at لا الـ job ولا أي TTL (§6.2 D16).
 */
export async function startRound(
  db: Db,
  tenantId: string,
  orderId: string,
  round: number,
): Promise<{ offerId: string; driverId: string; expiresAt: Date } | { exhausted: true }> {
  return withTenant(db, tenantId, async (tx) => {
    // §16.11: قفل صف الطلب قبل أي قرار — يحسم سباق "أُسند يدوياً/أُلغي بينما الجولة تنطلق".
    const lockedOrders = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    const order = lockedOrders[0];
    if (!order) {
      // §16.12: طلب غير موجود (أو محجوب بـ RLS) = باغ مستدعٍ، لا حالة عمل — فشل صاخب.
      throw new Error(`startRound: order ${orderId} not found`);
    }
    if (order.status !== "confirmed") {
      // سباق محسوم: الطلب أُسند/أُلغي قبل وصولنا — لا جولة. القرار من صف القاعدة (D16).
      return { exhausted: true } as const;
    }

    // Idempotency (§12: التسليم at-least-once — مهمة dispatch-order قد تتكرر):
    // عرض pending قائم لهذا الطلب → أعده كما هو بدل خلق عرض ثانٍ متوازٍ.
    // قراءة بلا FOR UPDATE عمداً: ترتيب الأقفال بكل المسارات الأخرى offer→order،
    // ونحن نمسك قفل الطلب — قفل العرض هنا يفتح باب deadlock مع acceptOffer/timeout.
    // أسوأ حالة: نعيد عرضاً يُقبل/ينتهي بعد لحظة — معالجا القبول والمهلة idempotent.
    const pendingRows = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.orderId, orderId), eq(offers.status, "pending")))
      .limit(1);
    const pending = pendingRows[0];
    if (pending) {
      return { offerId: pending.id, driverId: pending.driverId, expiresAt: pending.expiresAt } as const;
    }

    const candidates = await findCandidates(tx, order, round);
    const first = candidates[0];
    if (!first) {
      // لا مرشّح بهذا النطاق — المستهلك يقرر (جولة أوسع أو تنبيه الموزّع §6.2).
      return { exhausted: true } as const;
    }

    const expiresAt = new Date(Date.now() + OFFER_TTL_MS); // D6: UTC
    const inserted = await tx
      .insert(offers)
      .values({
        tenantId,
        orderId,
        driverId: first.driverId,
        status: "pending",
        expiresAt,
        round,
      })
      .returning({ id: offers.id });
    const offerRow = inserted[0];
    if (!offerRow) {
      // §16.12 — لا ابتلاع: INSERT ... RETURNING بلا صف حالة مستحيلة.
      throw new Error("startRound: INSERT offers ... RETURNING returned no row");
    }

    // D9: البطاقة + جدولة offer-timeout عند expires_at يتولاهما المستهلك بعد الالتزام.
    await writeOutbox(tx, tenantId, "offer.created", {
      offerId: offerRow.id,
      orderId,
      driverId: first.driverId,
      round,
      expiresAt: expiresAt.toISOString(),
    });

    return { offerId: offerRow.id, driverId: first.driverId, expiresAt } as const;
  });
}

/**
 * §6.2 D16 — نتيجة القبول: كلها مشتقة من صفوف القاعدة تحت الأقفال،
 * لا من وجود/غياب أي مفتاح Redis ("غياب مفتاح متطاير لا يثبت شيئاً").
 * تحويلها لرسائل مستخدم مسؤولية طبقة البوت (driver-flow).
 */
export type AcceptResult =
  | { outcome: "accepted"; orderId: string }
  | { outcome: "already_yours" }
  | { outcome: "taken" }
  | { outcome: "expired" }
  | { outcome: "not_found" };

/**
 * §6.2 حرفياً — القبول = ترانزاكشن واحدة، أول من يكسب قفل الطلب يفوز
 * (يصلح كما هو للجولة الأحادية وللبث "أول من يقبل" بلا آلية منفصلة):
 * اقرأ العرض FOR UPDATE → اقفل صف الطلب FOR UPDATE → اشتق أي رفض من الصفوف →
 * اقفل صف السائق وافحص سعته (D14، قبل لمس العرض — لا حاجة لأي rollback) →
 * UPDATE offers → 'accepted' → transition(assigned) (D8، يكتب orders.driver_id
 * وorder_events وoutbox بنفس الترانزاكشن) → علّم بقية عروض الطلب pending → 'expired'
 * + outbox 'offer.superseded' (تعديل بطاقاتهم "استُلم الطلب" بعد الالتزام — D9).
 */
export async function acceptOffer(
  db: Db,
  tenantId: string,
  offerId: string,
  driverId: string,
): Promise<AcceptResult> {
  return withTenant(db, tenantId, async (tx) => {
    // ترتيب الأقفال الموحّد بكل مسارات الإسناد: offer → order (→ driver).
    const offerRows = await tx.select().from(offers).where(eq(offers.id, offerId)).for("update");
    const offer = offerRows[0];
    if (!offer) {
      return { outcome: "not_found" } as const;
    }
    if (offer.driverId !== driverId) {
      // زر مزوّر/معاد توجيهه — العرض ليس له؛ لا نكشف شيئاً عن عروض غيره.
      return { outcome: "not_found" } as const;
    }

    const orderRows = await tx.select().from(orders).where(eq(orders.id, offer.orderId)).for("update");
    const order = orderRows[0];
    if (!order) {
      // §16.12: عرض بلا طلب مستحيل (FK مركّب) — فشل صاخب لا ابتلاع.
      throw new Error(`acceptOffer: order ${offer.orderId} for offer ${offerId} not found`);
    }

    // —— اشتقاق الرفض من الصفوف (§6.2 D16)، بترتيب الأولوية الأصدق للسائق ——
    if (offer.status === "accepted") {
      return { outcome: "already_yours" } as const; // "سبق أن قبلت"
    }
    if (order.driverId !== null) {
      // الطلب مُسند فعلاً: له بمسار آخر (إسناد يدوي) أو لغيره ("استُلم الطلب").
      return order.driverId === driverId
        ? ({ outcome: "already_yours" } as const)
        : ({ outcome: "taken" } as const);
    }
    if (offer.status !== "pending" || offer.expiresAt.getTime() <= Date.now()) {
      // rejected (رفض ثم حاول القبول) أو expired أو مهلة العمود انقضت والـ timeout
      // job لم يستيقظ بعد — offers.expires_at هو مصدر الحقيقة لا الـ job (§6.2).
      // pending المنقضي لا يُعلَّم هنا: تعليمه expired مسؤولية handleOfferTimeout
      // حصراً — هو من يوسّع الجولة، وقتله هنا يترك الطلب معلقاً بلا توسيع.
      return { outcome: "expired" } as const;
    }
    if (order.status !== "confirmed") {
      // أُلغي بينما العرض معلّق (الزبون/المكتب) — "الطلب لم يعد متاحاً".
      return { outcome: "expired" } as const;
    }

    // —— D14: اقفل صف السائق وافحص السعة قبل لمس العرض (§5: سباق محركين على نفس
    // السائق — الثاني يرى السعة ممتلئة). العرض يبقى pending كما هو: مهلته ستنتهي
    // ويوسّع handleOfferTimeout الجولة طبيعياً — لا rollback ولا طلب معلّق. ——
    const driverRows = await tx.select().from(drivers).where(eq(drivers.id, driverId)).for("update");
    const driver = driverRows[0];
    if (!driver) {
      throw new Error(`acceptOffer: driver ${driverId} not found`); // §16.12
    }
    const countRows = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(
        and(
          eq(orders.driverId, driverId),
          inArray(orders.status, [...DRIVER_ACTIVE_ORDER_STATUSES]),
          isNull(orders.deletedAt), // D10
        ),
      );
    const activeCount = countRows[0]?.n;
    if (activeCount === undefined) {
      throw new Error("acceptOffer: capacity count query returned no row"); // §16.12
    }
    if (activeCount >= driver.maxConcurrentOrders) {
      // سعته امتلأت بين إرسال العرض والضغط. لا outcome مخصص بالعقد — الأقرب
      // للحقيقة أن العرض لم يعد قابلاً للتلبية له: 'expired' (بطاقته ستُغلق
      // عند انتهاء المهلة الفعلي، والجولة تتوسع لغيره).
      return { outcome: "expired" } as const;
    }

    const now = new Date(); // D6: UTC
    // §6.2: UPDATE مشروط بـ status='pending' حزاماً فوق القفل — rowcount ≠ 1 هنا،
    // بعد كل الفحوص تحت الأقفال، حالة مستحيلة تستحق صوتاً عالياً (§16.12).
    const acceptedRows = await tx
      .update(offers)
      .set({ status: "accepted", respondedAt: now, updatedAt: now })
      .where(and(eq(offers.id, offerId), eq(offers.status, "pending")))
      .returning({ id: offers.id });
    if (acceptedRows.length !== 1) {
      throw new Error(
        `acceptOffer: expected exactly 1 accepted offer row for ${offerId}, got ${acceptedRows.length}`,
      );
    }

    // D8: تغيير الحالة عبر transition() حصراً — يكتب driver_id وorder_events
    // وoutbox 'order.status_changed' بنفس الترانزاكشن (بطاقات الزبون/السائق بعد الالتزام D9).
    await transition(tx, {
      orderId: order.id,
      to: "assigned",
      actor: { type: "driver", id: driverId },
      driverId,
    });

    // §6.2: بقية عروض الطلب المعلّقة (بث مستقبلي — بالجولة الأحادية v1 صفر صفوف)
    // تُعلَّم expired، وتعديل بطاقاتهم "استُلم الطلب" يمر outbox → بعد الالتزام (D9).
    // ملاحظة بث لاحقة: مع عروض متوازية فعلاً يُفضَّل SELECT ... FOR UPDATE SKIP LOCKED
    // قبل هذا الـ UPDATE لتفادي تشابك أقفال مع قبولات متزامنة على الأشقاء.
    const superseded = await tx
      .update(offers)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(offers.orderId, order.id), eq(offers.status, "pending"), ne(offers.id, offerId)))
      .returning({ id: offers.id, driverId: offers.driverId });
    // صف outbox واحد لكل عرض مُبطَل بالشكل المفرد الذي يقرؤه المستهلك (offer.expired نفسه)؛
    // البث المتعدّد بشكل جمعي كان يفشل تحليل Zod ويُهمل كل الإشعارات (كُشف بالنبش الحي).
    for (const o of superseded) {
      await writeOutbox(tx, tenantId, "offer.superseded", { offerId: o.id, orderId: order.id, driverId: o.driverId });
    }

    return { outcome: "accepted", orderId: order.id } as const;
  });
}

/**
 * §10.1 — الإسناد اليدوي من الموزّع: نفس انضباط acceptOffer (D16: القاعدة هي
 * السلطة، كل قرار من صفوف مقفولة) لكن بلا صف عرض — الموزّع هو المُطلِق.
 * ترانزاكشن واحدة: اقفل صف الطلب FOR UPDATE (لازم confirmed وبلا سائق) ←
 * اقفل صف السائق وتحقق status='online' والسعة D14 ← transition(assigned بفاعل
 * staff — D8، يكتب orders.driver_id وorder_events وoutbox بنفس الترانزاكشن) ←
 * علّم عروض الطلب pending → expired + outbox 'offer.superseded' (تعديل بطاقات
 * السائقين "استُلم الطلب" بعد الالتزام — D9).
 *
 * ترتيب الأقفال: order → driver → offers. عروض pending تُقفَل بـ SKIP LOCKED —
 * عرض مقفول = acceptOffer متزامن يمسك قفل عرضه (offer→order) وينتظر قفل الطلب
 * الذي بيدنا؛ انتظارُه هنا deadlock مؤكد. نتخطاه بأمان: سيستيقظ بعد التزامنا،
 * يرى driver_id مكتوباً → 'taken'، وعرضه المعلّق يعلّمه handleOfferTimeout لاحقاً.
 *
 * النتائج تعيد استخدام AcceptResult (§6.2): مُسند لغيره → 'taken'؛ حالة غير
 * confirmed أو سائق بلا وردية/سعة → 'expired' ("غير قابل للإسناد الآن")؛
 * طلب/سائق غير موجود (أو محجوب بـ RLS) → 'not_found' — من API حالة عمل (404)
 * لا باغ، لأن المعرّف مدخل مستخدم لا صف مضمون كوجود العرض بمهمة timeout.
 */
export async function assignManually(
  db: Db,
  tenantId: string,
  orderId: string,
  driverId: string,
  staffId?: string,
): Promise<AcceptResult> {
  return withTenant(db, tenantId, async (tx) => {
    const orderRows = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    const order = orderRows[0];
    if (!order) {
      return { outcome: "not_found" } as const;
    }
    if (order.deletedAt !== null) {
      return { outcome: "not_found" } as const; // D10: المحذوف ناعماً غير موجود للعمليات
    }
    if (order.driverId !== null) {
      // مُسند فعلاً: لنفس السائق = نجاح idempotent (§16.7 — الموظف يضغط مرتين)؛ لغيره = 'taken'.
      return order.driverId === driverId
        ? ({ outcome: "already_yours" } as const)
        : ({ outcome: "taken" } as const);
    }
    if (order.status !== "confirmed") {
      // §5: الإسناد (اليدوي أو الآلي) من confirmed حصراً — أي حالة أخرى = "لم يعد قابلاً للإسناد".
      return { outcome: "expired" } as const;
    }

    // —— D14: اقفل صف السائق ثم افحص الوردية والسعة (نفس acceptOffer — §5:
    // سباق إسنادين/محرك dispatch على نفس السائق يحسمه قفل صفه). ——
    const driverRows = await tx.select().from(drivers).where(eq(drivers.id, driverId)).for("update");
    const driver = driverRows[0];
    if (!driver) {
      return { outcome: "not_found" } as const;
    }
    if (driver.status !== "online") {
      // §6.1: وردية مغلقة — الإسناد اليدوي لا يتجاوز شرط online (لا فشل صامت لاحقاً).
      return { outcome: "expired" } as const;
    }
    const countRows = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(
        and(
          eq(orders.driverId, driverId),
          inArray(orders.status, [...DRIVER_ACTIVE_ORDER_STATUSES]),
          isNull(orders.deletedAt), // D10
        ),
      );
    const activeCount = countRows[0]?.n;
    if (activeCount === undefined) {
      throw new Error("assignManually: capacity count query returned no row"); // §16.12
    }
    if (activeCount >= driver.maxConcurrentOrders) {
      return { outcome: "expired" } as const; // سعته ممتلئة (D14) — الموزّع يختار غيره
    }

    // D8: تغيير الحالة عبر transition() حصراً — meta.manual يميّز الإسناد اليدوي بسجل order_events.
    await transition(tx, {
      orderId: order.id,
      to: "assigned",
      actor: { type: "staff", ...(staffId !== undefined ? { id: staffId } : {}) },
      meta: { manual: true },
      driverId,
    });

    // §6.2: عروض الطلب المعلّقة تُعلَّم expired — SKIP LOCKED (انظر تعليق الترتيب أعلاه).
    const now = new Date(); // D6: UTC
    const pendingOffers = await tx
      .select({ id: offers.id, driverId: offers.driverId })
      .from(offers)
      .where(and(eq(offers.orderId, order.id), eq(offers.status, "pending")))
      .for("update", { skipLocked: true });
    if (pendingOffers.length > 0) {
      await tx
        .update(offers)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            inArray(
              offers.id,
              pendingOffers.map((o) => o.id),
            ),
            eq(offers.status, "pending"), // حزام فوق القفل — الصفوف مقفولة بيدنا أصلاً
          ),
        );
      // صف مفرد لكل عرض (الشكل الذي يقرؤه المستهلك) — انظر التعليق بـ acceptOffer.
      for (const o of pendingOffers) {
        await writeOutbox(tx, tenantId, "offer.superseded", { offerId: o.id, orderId: order.id, driverId: o.driverId });
      }
    }

    return { outcome: "accepted", orderId: order.id } as const;
  });
}

/**
 * §6.2 — رفض صريح من السائق: UPDATE مشروط ذرّي (القراءة والكتابة بعبارة واحدة
 * تأخذ قفل الصف — §16.11). rowcount 0 = سباق بريء (انتهت مهلته/قُبل الطلب لغيره
 * قبل وصول الضغطة) — ليس خطأً، والحقيقة محفوظة بالصفوف؛ بطاقة السائق تُحدَّث
 * من طبقة البوت بعد رجوع الدالة.
 *
 * v1: الرفض لا يوسّع الجولة فوراً — نترك المهلة تنتهي وhandleOfferTimeout يوسّع
 * (مسار توسيع واحد لا اثنان). التوسيع الفوري عند الرفض تحسين لاحق.
 */
export async function rejectOffer(db: Db, tenantId: string, offerId: string, driverId: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const now = new Date(); // D6: UTC
    await tx
      .update(offers)
      .set({ status: "rejected", respondedAt: now, updatedAt: now })
      .where(and(eq(offers.id, offerId), eq(offers.driverId, driverId), eq(offers.status, "pending")));
  });
}

/**
 * §6.2 — معالج مهمة الـ timeout (الـ delayed job): يخضع لنفس انضباط الأقفال —
 * offer ثم order FOR UPDATE. مصدر الحقيقة الوحيد للمهلة = offers.expires_at،
 * لا TTL مفتاح ولا توقيت الـ job (D16). العرض لم يعد pending أو الطلب لم يعد
 * confirmed → خروج صامت بلا توسيع (سباق مع قبول/إلغاء جارٍ — §5).
 *
 * انتهاء فعلي: علّم expired + outbox 'offer.expired' (بطاقة السائق بعد الالتزام D9)
 * ثم: round < MAX_DISPATCH_ROUNDS → {nextRound} (المستهلك يعيد جدولة dispatch-order)؛
 * وإلا outbox 'dispatch.exhausted' → تنبيه صوتي + بصري للموزّع بالداشبورد —
 * لا دوران صامت للأبد (§6.2).
 */
export async function handleOfferTimeout(
  db: Db,
  tenantId: string,
  offerId: string,
): Promise<{ nextRound: number } | { done: true }> {
  return withTenant(db, tenantId, async (tx) => {
    const offerRows = await tx.select().from(offers).where(eq(offers.id, offerId)).for("update");
    const offer = offerRows[0];
    if (!offer) {
      // §16.12: العروض لا تُحذف — مهمة تحمل معرّفاً غير موجود = باغ، لا حالة عمل.
      throw new Error(`handleOfferTimeout: offer ${offerId} not found`);
    }

    const orderRows = await tx.select().from(orders).where(eq(orders.id, offer.orderId)).for("update");
    const order = orderRows[0];
    if (!order) {
      throw new Error(`handleOfferTimeout: order ${offer.orderId} for offer ${offerId} not found`); // §16.12
    }

    if (offer.status !== "pending" || order.status !== "confirmed") {
      // قُبل/رُفض/أُلغي الطلب قبل استيقاظنا — خروج صامت بلا توسيع جولة (§6.2).
      return { done: true } as const;
    }

    // انتهاء فعلي — respondedAt يبقى NULL: لم يرد أصلاً، هذا ليس رداً.
    const now = new Date(); // D6: UTC
    const expired = await tx
      .update(offers)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(offers.id, offerId), eq(offers.status, "pending")))
      .returning({ id: offers.id });
    if (expired.length !== 1) {
      // §16.12: الصف مقفول ومفحوص pending للتو — غير ذلك مستحيل.
      throw new Error(`handleOfferTimeout: expected exactly 1 expired row for ${offerId}, got ${expired.length}`);
    }

    await writeOutbox(tx, tenantId, "offer.expired", {
      offerId: offer.id,
      orderId: order.id,
      driverId: offer.driverId,
    });

    if (offer.round < MAX_DISPATCH_ROUNDS) {
      return { nextRound: offer.round + 1 } as const;
    }

    // §6.2: بعد MAX_DISPATCH_ROUNDS جولات فاشلة — تنبيه الموزّع، لا دوران صامت.
    await writeOutbox(tx, tenantId, "dispatch.exhausted", {
      orderId: order.id,
      round: offer.round, // المفتاح الذي يقرؤه المستهلك (كان 'rounds' فيُسجَّل round:null)
    });
    return { done: true } as const;
  });
}
