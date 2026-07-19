import { and, eq, isNull } from "drizzle-orm";
import { computeDeliveryLedger, type OrderActorType, type OrderStatus } from "@quickdrop/shared";
import { applyDeliveryLoyalty, settleCouponOnTerminal } from "./loyalty.js";
import { writeOutbox } from "./outbox.js";
import { ledgerEntries, orderEvents, orders, tenants, type Order } from "./schema/index.js";
import type { Tx } from "./with-tenant.js";

// §5 — الحالات النهائية التي تُحرَّر عندها حجوزات الكوبون (§8.3-4): كل إلغاء/فشل
const COUPON_RELEASE_STATES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "cancelled_by_customer",
  "cancelled_by_office",
  "failed",
]);

// §5 v1.1 — آلة حالة الطلب. كل تغيير حالة بالنظام يمر من transition() الوحيدة:
// الداشبورد، البوت، الـ geofence، الـ cron — الكل. أي UPDATE orders SET status
// خارجها = باغ بالمراجعة (D8).

/**
 * §5 v1.1 — جدول الانتقالات المسموحة: من كل حالة، إلى أين ومَن يحق له.
 * redelivery ليست حالة: إعادة التوصيل = طلب جديد بـ origin_order_id وتسعير مستقل؛
 * الأصل ينتهي failed/returned.
 */
export const TRANSITIONS: Record<OrderStatus, { to: OrderStatus; allowedActors: OrderActorType[] }[]> = {
  draft: [
    { to: "pending", allowedActors: ["customer", "staff"] },
    // §5: تأكيد طلب بموعد مستقبلي — المسار المجدول
    { to: "scheduled", allowedActors: ["customer", "staff"] },
  ],
  scheduled: [
    // §6.3: عند الموعد تطلقه مهمة الجدولة — فاعل system حصراً
    { to: "pending", allowedActors: ["system"] },
    // §5 v1.1: الطلب المجدول قابل للإلغاء — زبون حجز لبكرا لازم يقدر يتراجع
    { to: "cancelled_by_customer", allowedActors: ["customer"] },
    { to: "cancelled_by_office", allowedActors: ["staff", "merchant"] },
  ],
  pending: [
    // merchant (§4.2 D-M6): قبول التاجر لطلب معلّق = بوابة البشر — يؤكّد ثم يبدأ التحضير
    { to: "confirmed", allowedActors: ["staff", "system", "merchant"] },
    { to: "cancelled_by_customer", allowedActors: ["customer"] },
    { to: "cancelled_by_office", allowedActors: ["staff", "merchant"] },
  ],
  confirmed: [
    // §6.2: قبول السائق (driver)، إسناد يدوي من الموزّع (staff)، أو dispatch آلي (system)
    { to: "assigned", allowedActors: ["driver", "staff", "system"] },
    // دمج WaFlow (§4.2 D-M6): قبول التاجر = هذا الانتقال (يضبط merchant_confirmed_at) —
    // ترميز واحد للحقيقة. حارس service='food' داخل transition (adversary #19).
    { to: "preparing", allowedActors: ["merchant", "staff"] },
    { to: "cancelled_by_customer", allowedActors: ["customer"] },
    { to: "cancelled_by_office", allowedActors: ["staff", "merchant"] },
  ],
  // دمج WaFlow (§4.2.4) — حالتا المطبخ: بدون حواف الإلغاء طلبات المطبخ غير قابلة للقتل
  // وتحرير الكوبون غير قابل للبلوغ (adversary #9). الإسناد من preparing|ready جائز (§4.2.3).
  preparing: [
    { to: "ready", allowedActors: ["merchant", "staff", "system"] },
    { to: "assigned", allowedActors: ["driver", "staff", "system"] },
    { to: "cancelled_by_office", allowedActors: ["staff", "merchant"] },
  ],
  ready: [
    { to: "assigned", allowedActors: ["driver", "staff", "system"] },
    { to: "cancelled_by_office", allowedActors: ["staff", "merchant"] },
  ],
  assigned: [
    { to: "picked_up", allowedActors: ["driver"] },
    // §5: إعادة الإسناد بعد الاستلام ممنوعة بالجدول — لازم failed أولاً بسبب مسمّى
    { to: "failed", allowedActors: ["driver", "staff"] },
  ],
  picked_up: [
    // §5 v1.1: تلقائياً بفاعل system عند أول تحديث موقع غير مشبوه بعد الاستلام
    // (أو بزر السائق كاحتياط) — بلا مُطلِق معرّف، الـ geofence لا يتسلح أبداً
    { to: "in_transit", allowedActors: ["system", "driver"] },
    { to: "failed", allowedActors: ["driver", "staff"] },
  ],
  in_transit: [
    // §7: الـ geofence (نقطتان متتاليتان ضمن 150م) بفاعل system، أو السائق يدوياً
    { to: "arrived", allowedActors: ["system", "driver"] },
    { to: "failed", allowedActors: ["driver", "staff"] },
  ],
  arrived: [
    { to: "delivered", allowedActors: ["driver", "staff"] },
    { to: "failed", allowedActors: ["driver", "staff"] },
  ],
  failed: [{ to: "returned", allowedActors: ["driver", "staff"] }],
  // حالات نهائية — لا انتقالات خارجة منها
  delivered: [],
  cancelled_by_customer: [],
  cancelled_by_office: [],
  returned: [],
};

/**
 * §5 — يرميها transition() عند انتقال غير موجود بالجدول أو فاعل غير مخوّل.
 * تحمل from/to/actorType ليشتق المستدعي الرسالة المناسبة
 * (مثلاً: سائق يقبل طلباً أُلغي للتو → "الطلب لم يعد متاحاً").
 */
export class InvalidTransitionError extends Error {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly actorType: OrderActorType;

  constructor(from: OrderStatus, to: OrderStatus, actorType: OrderActorType) {
    super(`invalid order transition: ${from} -> ${to} by actor '${actorType}'`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.actorType = actorType;
  }
}

/**
 * §5 — الدالة الوحيدة لتغيير حالة طلب. تُستدعى داخل ترانزاكشن مفتوحة أصلاً
 * عبر withTenant (§2.2) — القفل والسجل والـ outbox كلها ذرّية معاً.
 *
 * ملاحظة promised_at (§7): لقطة الوعد تُثبَّت لحظة confirmed من قبل المستدعي
 * (orders-service — هو من يملك الـ ETA) وليس هنا؛ transition لا يعرف OSRM.
 */
export async function transition(
  tx: Tx,
  args: {
    orderId: string;
    to: OrderStatus;
    actor: { type: OrderActorType; id?: string };
    meta?: Record<string, unknown>;
    driverId?: string;
    /** الفخ 18: المُحصَّل فعلياً عند التسليم — غيابه = التحصيل الكامل (cod_amount). */
    codReceived?: bigint;
  },
): Promise<Order> {
  // §5: قفل الصف إلزامي — يحسم السباقات (الزبون يلغي والسائق يقبل بنفس اللحظة:
  // أحدهما ينتظر القفل، والثاني يفشل بـ InvalidTransitionError).
  const locked = await tx.select().from(orders).where(eq(orders.id, args.orderId)).for("update");
  const order = locked[0];
  if (!order) {
    // §16.12: لا ابتلاع أخطاء — طلب غير موجود (أو محجوب بـ RLS خارج المستأجر) خطأ صريح
    throw new Error(`transition: order ${args.orderId} not found`);
  }

  const from = order.status;
  const rule = TRANSITIONS[from].find((t) => t.to === args.to);
  if (!rule || !rule.allowedActors.includes(args.actor.type)) {
    throw new InvalidTransitionError(from, args.to, args.actor.type);
  }

  // §4.2 (adversary #19) — حالتا المطبخ لطلبات الطعام حصراً: p2p/parcel لا "تحضير" لها
  if ((args.to === "preparing" || args.to === "ready") && order.service !== "food") {
    throw new InvalidTransitionError(from, args.to, args.actor.type);
  }

  // الحقول المشتقة تُكتب حصراً داخل هذه الترانزاكشن (§3: driver_id/delivered_at)
  let driverId: string | undefined;
  if (args.to === "assigned") {
    if (args.driverId === undefined) {
      throw new TypeError("transition: driverId is required when to='assigned' (§5/§6.2)");
    }
    driverId = args.driverId;
  }

  let failedReason: string | undefined;
  if (args.to === "failed") {
    // §5: failed بسبب مسمّى — بلا سبب لا يوجد فشل صالح
    const reason = args.meta?.["failedReason"];
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TypeError("transition: meta.failedReason (non-empty string) is required when to='failed' (§5)");
    }
    failedReason = reason;
  }

  // §8.1 v1.1 — عند التسليم: المُحصَّل الفعلي (الفخ 18) وقيود الدفتر بنفس الترانزاكشن
  let codReceived: bigint | undefined;
  if (args.to === "delivered") {
    if (!order.driverId) {
      // §16.12: طلب يُسلَّم بلا سائق مُسنَد = فساد حالة يستحق صوتاً عالياً
      throw new Error(`transition: order ${args.orderId} reached delivered without a driver_id`);
    }
    codReceived = args.codReceived ?? order.codAmount;
    if (codReceived < 0n) {
      throw new RangeError("transition: codReceived must be non-negative");
    }
  }

  const now = new Date(); // D6: يُخزَّن TIMESTAMPTZ بتوقيت UTC

  const updated = await tx
    .update(orders)
    .set({
      status: args.to,
      updatedAt: now,
      ...(args.to === "delivered" ? { deliveredAt: now } : {}),
      // §4.2 D-M6: دخول preparing = قبول التاجر — يملأ merchant_confirmed_at (مرة واحدة)
      ...(args.to === "preparing" && order.merchantConfirmedAt === null ? { merchantConfirmedAt: now } : {}),
      // §4.1: ready_at علم جهوز المطبخ — write-once (ready لا يُعاد دخولها بالآلة)
      ...(args.to === "ready" && order.readyAt === null ? { readyAt: now } : {}),
      ...(codReceived !== undefined ? { codReceived } : {}),
      ...(driverId !== undefined ? { driverId } : {}),
      ...(failedReason !== undefined ? { failedReason } : {}),
    })
    .where(eq(orders.id, args.orderId)) // §5: UPDATE بلا WHERE = كارثة على كل الجدول
    .returning();

  const next = updated[0];
  if (updated.length !== 1 || !next) {
    // §16.12: صف مقفول ثم لم يتحدّث صف واحد بالضبط — حالة مستحيلة تستحق صوتاً عالياً
    throw new Error(`transition: expected exactly 1 updated row for order ${args.orderId}, got ${updated.length}`);
  }

  // §3: order_events سجل append-only — مصدر الحقيقة لتاريخ الطلب والتدقيق
  await tx.insert(orderEvents).values({
    tenantId: order.tenantId,
    orderId: order.id,
    fromStatus: from,
    toStatus: args.to,
    actorType: args.actor.type,
    actorId: args.actor.id ?? null,
    meta: args.meta ?? null,
  });

  // §8.1 v1.1 — قيود الدفتر بنفس ترانزاكشن انتقال delivered (D13: cod + goods + fee).
  // الرصيد = SUM لا عمود؛ append-only — التصحيح قيد adjustment جديد (§8.2).
  if (args.to === "delivered" && codReceived !== undefined && order.driverId) {
    const tenantRows = await tx
      .select({
        driverFeeShareBp: tenants.driverFeeShareBp,
        loyaltyPointsPerOrder: tenants.loyaltyPointsPerOrder,
        referralBonusPoints: tenants.referralBonusPoints,
        referralMonthlyCap: tenants.referralMonthlyCap,
        timezone: tenants.timezone, // §16.8 — نافذة سقف الإحالة الشهري بمنطقة المستأجر
      })
      .from(tenants)
      .where(eq(tenants.id, order.tenantId))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant) {
      throw new Error(`transition: tenant ${order.tenantId} not found for ledger write`);
    }
    const entries = computeDeliveryLedger(
      { priceTotal: order.priceTotal, goodsAmount: order.goodsAmount, codReceived },
      tenant.driverFeeShareBp,
    );
    if (entries.length > 0) {
      await tx.insert(ledgerEntries).values(
        entries.map((entry) => ({
          tenantId: order.tenantId,
          driverId: order.driverId!,
          orderId: order.id,
          entryType: entry.entryType,
          amount: entry.amount,
          createdBy: args.actor.id ?? null,
        })),
      );
    }

    // §9 v1.1 — منح الولاء وإتمام الإحالة عند التسليم فقط (بنفس الترانزاكشن)
    await applyDeliveryLoyalty(tx, order, tenant);
    // §8.3-4 — استهلاك حجز الكوبون (إن وُجد)
    await settleCouponOnTerminal(tx, order.tenantId, order.id, "consumed");
  }

  // §8.3-4 v1.1 — تحرير حجز الكوبون عند أي إلغاء/فشل (يعيد الاستخدام للمخزون)
  if (COUPON_RELEASE_STATES.has(args.to)) {
    await settleCouponOnTerminal(tx, order.tenantId, order.id, "released");
  }

  // D9: لا نداء تيليغرام داخل الترانزاكشن — صف outbox بنفس الترانزاكشن،
  // والإرسال الفعلي بعد الالتزام عبر العامل (§12)
  await writeOutbox(tx, order.tenantId, "order.status_changed", {
    orderId: order.id,
    from,
    to: args.to,
  });

  // ——— المفصل (§4.2.3 / D-M1) — المنتِج الشرعي الوحيد لـ order.ready_for_dispatch ———
  // ختم write-once: UPDATE شرطي على dispatch_requested_at IS NULL؛ صف الحدث يُكتب فقط
  // حين يصيب الختم صفاً واحداً — **بنفس ترانزاكشن تغيير الحالة** (outbox ترانزاكشني D6).
  // نحمل قفل صف الطلب FOR UPDATE أصلاً، فخمس محاولات متزامنة تتسلسل والأولى فقط تختم.
  // التوقيت: parcel/p2p عند confirmed؛ food حسب tenants.dispatch_trigger ('ready'
  // الافتراضي — عند جهوز المطبخ؛ أو 'confirmed')؛ pickup لا يُختم أبداً (لا رحلة توصيل).
  // الحمولة {orderId} = سكيما spine (packages/spine يعتمد على db فالكتابة مباشرة هنا؛
  // المستهلك يتحقق بـ parseSpineEvent).
  if ((args.to === "confirmed" || args.to === "ready") && order.fulfillment === "delivery") {
    let shouldClaim = false;
    if (args.to === "ready") {
      shouldClaim = true; // food فقط تصل ready؛ لو كان المُطلِق 'confirmed' فالختم سبق والشرط يمنع الازدواج
    } else if (order.service !== "food") {
      shouldClaim = true; // parcel/p2p: عند التأكيد
    } else {
      const trigRows = await tx
        .select({ dispatchTrigger: tenants.dispatchTrigger })
        .from(tenants)
        .where(eq(tenants.id, order.tenantId))
        .limit(1);
      shouldClaim = (trigRows[0]?.dispatchTrigger ?? "ready") === "confirmed";
    }
    if (shouldClaim) {
      const claimed = await tx
        .update(orders)
        .set({ dispatchRequestedAt: now, updatedAt: now })
        .where(and(eq(orders.id, order.id), isNull(orders.dispatchRequestedAt), eq(orders.fulfillment, "delivery")))
        .returning({ id: orders.id });
      if (claimed.length === 1) {
        await writeOutbox(tx, order.tenantId, "order.ready_for_dispatch", { orderId: order.id });
      }
    }
  }

  return next;
}
