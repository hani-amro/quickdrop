import { eq } from "drizzle-orm";
import type { OrderActorType, OrderStatus } from "@quickdrop/shared";
import { writeOutbox } from "./outbox.js";
import { orderEvents, orders, type Order } from "./schema/index.js";
import type { Tx } from "./with-tenant.js";

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
    { to: "cancelled_by_office", allowedActors: ["staff"] },
  ],
  pending: [
    { to: "confirmed", allowedActors: ["staff", "system"] },
    { to: "cancelled_by_customer", allowedActors: ["customer"] },
    { to: "cancelled_by_office", allowedActors: ["staff"] },
  ],
  confirmed: [
    // §6.2: قبول السائق (driver)، إسناد يدوي من الموزّع (staff)، أو dispatch آلي (system)
    { to: "assigned", allowedActors: ["driver", "staff", "system"] },
    { to: "cancelled_by_customer", allowedActors: ["customer"] },
    { to: "cancelled_by_office", allowedActors: ["staff"] },
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

  const now = new Date(); // D6: يُخزَّن TIMESTAMPTZ بتوقيت UTC

  const updated = await tx
    .update(orders)
    .set({
      status: args.to,
      updatedAt: now,
      ...(args.to === "delivered" ? { deliveredAt: now } : {}),
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

  // D9: لا نداء تيليغرام داخل الترانزاكشن — صف outbox بنفس الترانزاكشن،
  // والإرسال الفعلي بعد الالتزام عبر العامل (§12)
  await writeOutbox(tx, order.tenantId, "order.status_changed", {
    orderId: order.id,
    from,
    to: args.to,
  });

  return next;
}
