import { type DriverStatus, type OrderStatus } from "@quickdrop/shared";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { DRIVER_ACTIVE_ORDER_STATUSES } from "./dispatch.js";
import { drivers, offers, orderAttachments, orders, type Order } from "./schema/index.js";
import { InvalidTransitionError, transition } from "./state-machine.js";
import { withTenant } from "./with-tenant.js";

// §3/§5/§7 (P5.1) — أفعال السائق القابلة لإعادة الاستخدام، مستخرجة إلى packages/db كي تشترك
// قناتا السائق فيها: بوت تيليغرام (packages/telegram/driver-flow) وتطبيق PWA (apps/api/driver).
// كلها ضمن مستأجر (withTenant) وبأقفال صفوف عند القراءة-ثم-الكتابة (§16.11). لا شبكة (D9).

export type ShiftAction = "start" | "end" | "toggle";

/**
 * §3 — قلب الوردية: drivers.status offline↔online + shift_started_at. UPDATE عادي (حالة سائق
 * لا حالة طلب، D8)؛ §16.11 قفل صف السائق. ضغطة مكررة (نفس الهدف) idempotent بلا كتابة.
 */
export async function setDriverShift(db: Db, tenantId: string, driverId: string, action: ShiftAction): Promise<DriverStatus> {
  return withTenant(db, tenantId, async (tx) => {
    const locked = await tx.select({ status: drivers.status }).from(drivers).where(eq(drivers.id, driverId)).for("update");
    const current = locked[0];
    if (!current) throw new Error(`setDriverShift: driver ${driverId} not found`); // §16.12

    const target: DriverStatus =
      action === "start" ? "online" : action === "end" ? "offline" : current.status === "online" ? "offline" : "online";
    if (target === current.status) return target; // idempotent

    const now = new Date();
    await tx
      .update(drivers)
      .set({ status: target, shiftStartedAt: target === "online" ? now : null, updatedAt: now })
      .where(eq(drivers.id, driverId));
    return target;
  });
}

export type DriverTransitionResult = { ok: true; order: Order } | { ok: false; reason: "not_yours" | "invalid" };

/**
 * §5 D8 — انتقال حالة الطلب بيد السائق: قفل صف الطلب FOR UPDATE والتحقق أنه مُسند **لهذا
 * السائق** (transition يتحقق من الفاعل النوعي «driver» لا من الهوية)، ثم transition. السباق
 * محسوم بالقفل؛ الخاسر → invalid. لا بناء بطاقة تيليغرام هنا (المستدعي يبنيها إن احتاج).
 */
export async function driverTransition(
  db: Db,
  tenantId: string,
  driverId: string,
  orderId: string,
  to: OrderStatus,
): Promise<DriverTransitionResult> {
  try {
    return await withTenant(db, tenantId, async (tx) => {
      const locked = await tx.select({ driverId: orders.driverId }).from(orders).where(eq(orders.id, orderId)).for("update");
      const row = locked[0];
      if (!row || row.driverId !== driverId) return { ok: false as const, reason: "not_yours" as const }; // D16
      const order = await transition(tx, { orderId, to, actor: { type: "driver", id: driverId } });
      return { ok: true as const, order };
    });
  } catch (error) {
    if (error instanceof InvalidTransitionError) return { ok: false, reason: "invalid" };
    throw error; // §16.12
  }
}

export interface DriverOrderView {
  id: string;
  publicCode: string;
  status: OrderStatus;
  pickupText: string | null;
  dropoffText: string | null;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  priceTotal: string;
  codAmount: string;
  goodsAmount: string;
}

const driverOrderColumns = {
  id: orders.id,
  publicCode: orders.publicCode,
  status: orders.status,
  pickupText: orders.pickupText,
  dropoffText: orders.dropoffText,
  pickupLat: sql<number>`ST_Y(${orders.pickupPoint}::geometry)`,
  pickupLng: sql<number>`ST_X(${orders.pickupPoint}::geometry)`,
  dropoffLat: sql<number>`ST_Y(${orders.dropoffPoint}::geometry)`,
  dropoffLng: sql<number>`ST_X(${orders.dropoffPoint}::geometry)`,
  // المال نصاً عند الحد (D3/D5): BIGINT → string
  priceTotal: sql<string>`${orders.priceTotal}::text`,
  codAmount: sql<string>`${orders.codAmount}::text`,
  goodsAmount: sql<string>`${orders.goodsAmount}::text`,
} as const;

/** §5 — طلبات السائق النشطة (assigned..arrived، غير المحذوفة). للـ PWA بلا N+1. */
export async function listDriverAssignedOrders(db: Db, tenantId: string, driverId: string): Promise<DriverOrderView[]> {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select(driverOrderColumns)
      .from(orders)
      .where(
        and(eq(orders.driverId, driverId), inArray(orders.status, [...DRIVER_ACTIVE_ORDER_STATUSES]), isNull(orders.deletedAt)),
      )
      .orderBy(desc(orders.updatedAt)),
  );
}

export interface DriverOfferView extends DriverOrderView {
  offerId: string;
  round: number;
  expiresAt: string;
}

/**
 * §6.2 — عروض الإسناد المعلّقة لهذا السائق (لم تنتهِ مهلتها). لم تكن هناك دالة "عروض السائق" —
 * قناة تيليغرام تدفع البطاقة؛ الـ PWA يستقصيها. الفهرس offers_tenant_driver_status_idx يخدمها.
 */
export async function listDriverOffers(db: Db, tenantId: string, driverId: string): Promise<DriverOfferView[]> {
  const now = new Date();
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        offerId: offers.id,
        round: offers.round,
        expiresAt: sql<string>`to_char(${offers.expiresAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        ...driverOrderColumns,
      })
      .from(offers)
      .innerJoin(orders, and(eq(orders.tenantId, offers.tenantId), eq(orders.id, offers.orderId)))
      .where(
        and(
          eq(offers.driverId, driverId),
          eq(offers.status, "pending"),
          gt(offers.expiresAt, now),
          isNull(orders.deletedAt),
        ),
      )
      .orderBy(desc(offers.expiresAt)),
  );
}

// §11 v1.1 — إثبات التسليم: مساعدتا القاعدة (البحث عن الطلب النشط + إدراج المرفق). التخزين
// (إعادة الترميز + S3) يبقى عند المستدعي (worker أو driver API) — db لا يعتمد @quickdrop/storage.
export const POD_ACTIVE_STATUSES = ["picked_up", "in_transit", "arrived"] as const satisfies readonly OrderStatus[];

/** الطلب النشط للسائق لإرفاق POD (أحدثها) — null إن لا طلب نشط. */
export async function findDriverActiveOrderForPod(
  db: Db,
  tenantId: string,
  driverId: string,
): Promise<{ id: string; publicCode: string } | null> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: orders.id, publicCode: orders.publicCode })
      .from(orders)
      .where(and(eq(orders.driverId, driverId), inArray(orders.status, [...POD_ACTIVE_STATUSES]), isNull(orders.deletedAt)))
      .orderBy(desc(orders.updatedAt))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** إدراج مرفق POD ذرّياً ضمن المستأجر (بعد رفع الكائن للتخزين). */
export async function insertPodAttachment(
  db: Db,
  tenantId: string,
  orderId: string,
  objectKey: string,
  createdBy: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.insert(orderAttachments).values({ tenantId, orderId, kind: "pod_photo", objectKey, createdBy }),
  );
}
