import { makePoint, newId, toPostgisWkt, type CouponKind, type Point, type Service } from "@quickdrop/shared";
import { and, asc, eq } from "drizzle-orm";
import { createDb, type Db, type DbHandle } from "./client.js";
import { createOrder, type CreateOrderInput } from "./orders-service.js";
import {
  couponRedemptions,
  coupons,
  drivers,
  ledgerEntries,
  loyaltyAccounts,
  loyaltyEvents,
  offers,
  orderEvents,
  orders,
  pricingRules,
  staff,
  tenants,
  trackingTokens,
  users,
  type CouponRedemption,
  type LedgerEntry,
  type Offer,
  type Order,
  type OrderEvent,
} from "./schema/index.js";
import { loyaltyBalance } from "./loyalty.js";
import { createDriver } from "./tenant-admin.js";
import { transition } from "./state-machine.js";
import { withTenant } from "./with-tenant.js";

// §15 — عدّة اختبارات التكامل والسباقات. البذر يمرّ من مسارات الإنتاج نفسها
// (createOrder/transition/createDriver) — لا INSERT خام إلا حيث لا مسار إنتاج داخل
// packages/db أصلاً (مستأجر/زبون/قاعدة تسعير/كوبون/وردية السائق — تُدار من api/dashboard).
// التفعيل بنمط isolation.test.ts حرفياً: بلا DATABASE_URL/DATABASE_URL_MIGRATOR تُتخطى
// الحزم كلها (describe.skipIf) وتعمل بالـ CI حيث Postgres+Redis حاضران.

export const APP_URL = process.env["DATABASE_URL"];
export const MIGRATOR_URL = process.env["DATABASE_URL_MIGRATOR"];
export const hasDb = Boolean(APP_URL && MIGRATOR_URL);

export interface TestHarness {
  app: DbHandle;
  migrator: DbHandle;
}

/** تُستدعى داخل beforeAll لحزمة مفعّلة فقط (hasDb) — خارجها URLs غير مضمونة. */
export function connectHarness(): TestHarness {
  if (!APP_URL || !MIGRATOR_URL) {
    throw new Error("connectHarness: DATABASE_URL/DATABASE_URL_MIGRATOR are required (env-gated suite bug)");
  }
  return { app: createDb(APP_URL), migrator: createDb(MIGRATOR_URL) };
}

export async function closeHarness(h: TestHarness): Promise<void> {
  await h.app.close();
  await h.migrator.close();
}

/**
 * مسح كامل عبر migrator (مالك الجداول): كل جداول الأعمال تحمل FK إلى tenants فيجرفها
 * الـ CASCADE؛ webhook_updates صراحةً (نفس نمط isolation.test.ts). تُستدعى بأول كل ملف —
 * ملفات الاختبار تعمل تسلسلياً (vitest.config.ts: fileParallelism=false) فلا تمسح بعضها.
 */
export async function resetDb(h: TestHarness): Promise<void> {
  await h.migrator.pool.query("TRUNCATE webhook_updates, tenants CASCADE");
}

// ————————————————————————— بذر عالم اختبار —————————————————————————

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

export interface SeedTenantOpts {
  /** §8.1: حصة السائق bp — 8000 تجعل القيود الثلاثة بمبالغ متمايزة بالاختبارات. */
  driverFeeShareBp?: number;
  loyaltyPointsPerOrder?: number;
}

/** tenants استثناء RLS مسمّى (§2.4) — الإدراج المباشر هو نمط isolation.test.ts نفسه. */
export async function seedTenant(db: Db, opts: SeedTenantOpts = {}): Promise<string> {
  const n = nextSeq();
  const slug = `qa-${n}-${Date.now().toString(36)}`;
  const inserted = await db
    .insert(tenants)
    .values({
      slug,
      name: `QA Tenant ${n}`,
      nameAr: `مستأجر اختبار ${n}`,
      plan: "growth", // حد starter = 3 سائقين (§14) — لا نريد اصطدام حدود الباقة هنا
      ...(opts.driverFeeShareBp !== undefined ? { driverFeeShareBp: opts.driverFeeShareBp } : {}),
      ...(opts.loyaltyPointsPerOrder !== undefined ? { loyaltyPointsPerOrder: opts.loyaltyPointsPerOrder } : {}),
    })
    .returning({ id: tenants.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("seedTenant: INSERT tenants ... RETURNING returned no row"); // §16.12
  }
  return row.id;
}

/** إنشاء الزبائن مسؤولية بوت الزبون/شاشة D15 (apps/api) — هنا إدراج مباشر مبرَّر. */
export async function seedCustomer(db: Db, tenantId: string, firstName = "زبون اختبار"): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ tenantId, role: "customer", firstName, phoneE164: `+9639${String(nextSeq()).padStart(8, "0")}` })
      .returning({ id: users.id });
    const row = inserted[0];
    if (!row) {
      throw new Error("seedCustomer: INSERT users ... RETURNING returned no row"); // §16.12
    }
    return row.id;
  });
}

/** صف staff لتواقيع audit/settlement — إدارة الموظفين بالداشبورد، الإدراج المباشر مبرَّر. */
export async function seedStaff(db: Db, tenantId: string): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(staff)
      .values({
        tenantId,
        email: `qa-${nextSeq()}@example.test`,
        passwordHash: "x", // ليس سراً — قيمة شكلية لاختبار قيود لا للدخول (§11)
        role: "dispatcher",
      })
      .returning({ id: staff.id });
    const row = inserted[0];
    if (!row) {
      throw new Error("seedStaff: INSERT staff ... RETURNING returned no row"); // §16.12
    }
    return row.id;
  });
}

export interface SeedDriverOpts {
  /** موقع آخر نقطة — الافتراضي فوق نقطة الاستلام الافتراضية (مرشّح جولة 1 مؤكد §6.1). */
  point?: Point;
  maxConcurrentOrders?: number;
  online?: boolean;
}

/**
 * السائق عبر مسار الإنتاج createDriver (§14)، ثم فتح الوردية + آخر نقطة بتحديث مباشر —
 * فتح الوردية واستقبال المواقع مساران ببوت السائق (apps/api) خارج packages/db، فالتحديث
 * المباشر هنا هو البديل المبرَّر الوحيد.
 */
export async function seedDriver(db: Db, tenantId: string, opts: SeedDriverOpts = {}): Promise<string> {
  const phone = `+9638${String(nextSeq()).padStart(8, "0")}`;
  const created = await createDriver(db, tenantId, { vehicle: "motorbike", phone, name: "سائق اختبار" });
  if (created.outcome !== "created") {
    throw new Error(`seedDriver: expected outcome 'created', got '${created.outcome}'`); // §16.12
  }
  const driverId = created.driver.id;
  const point = opts.point ?? DEFAULT_PICKUP;
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .update(drivers)
      .set({
        status: opts.online === false ? "offline" : "online",
        lastPoint: toPostgisWkt(point), // D7: WKT بترتيب lng lat
        lastPointAt: new Date(), // D6: UTC — طازجة ضمن نافذة LOCATION_FRESHNESS_S
        shiftStartedAt: new Date(),
        ...(opts.maxConcurrentOrders !== undefined ? { maxConcurrentOrders: opts.maxConcurrentOrders } : {}),
      })
      .where(eq(drivers.id, driverId));
  });
  return driverId;
}

export interface SeedPricingRuleOpts {
  service?: Service;
  base?: bigint;
  perKm?: bigint;
  minTotal?: bigint;
}

/** قواعد التسعير تُدار من الداشبورد — إدراج مباشر مبرَّر. surge محايد (10000bp = ×1.0). */
export async function seedPricingRule(db: Db, tenantId: string, opts: SeedPricingRuleOpts = {}): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(pricingRules)
      .values({
        tenantId,
        service: opts.service ?? "food",
        base: opts.base ?? 5_000n,
        perKm: opts.perKm ?? 1_000n,
        perKg: 0n,
        minTotal: opts.minTotal ?? 0n,
        surgeMultiplierBp: 10_000,
        priority: 0,
      })
      .returning({ id: pricingRules.id });
    const row = inserted[0];
    if (!row) {
      throw new Error("seedPricingRule: INSERT pricing_rules ... RETURNING returned no row"); // §16.12
    }
    return row.id;
  });
}

export interface SeedCouponOpts {
  code: string;
  kind: CouponKind;
  value: bigint;
  maxUses?: number | null;
  maxUsesPerUser?: number | null;
}

/** الكوبونات تُدار من الداشبورد — إدراج مباشر مبرَّر. */
export async function seedCoupon(db: Db, tenantId: string, opts: SeedCouponOpts): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(coupons)
      .values({
        tenantId,
        code: opts.code,
        kind: opts.kind,
        value: opts.value,
        maxUses: opts.maxUses ?? null,
        maxUsesPerUser: opts.maxUsesPerUser ?? null,
        minOrderTotal: 0n,
        isActive: true,
      })
      .returning({ id: coupons.id });
    const row = inserted[0];
    if (!row) {
      throw new Error("seedCoupon: INSERT coupons ... RETURNING returned no row"); // §16.12
    }
    return row.id;
  });
}

/**
 * §9 — رصيد محفظة ابتدائي: حدث compensation موجب (append-only — نفس ما يفعله staff
 * بمسار التعويض). ضمان صف الحساب أولاً (مرساة قفل الاسترداد).
 */
export async function grantWallet(db: Db, tenantId: string, userId: string, amount: bigint): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .insert(loyaltyAccounts)
      .values({ tenantId, userId })
      .onConflictDoNothing({ target: [loyaltyAccounts.tenantId, loyaltyAccounts.userId] });
    await tx.insert(loyaltyEvents).values({ tenantId, userId, deltaWallet: amount, reason: "compensation" });
  });
}

// نقاط دمشق الافتراضية — المسافة ≈ 5كم جواً × 1.4 ≈ 7كم طريقاً (تسعير متمايز > 0)
export const DEFAULT_PICKUP: Point = makePoint(33.5138, 36.2765);
export const DEFAULT_DROPOFF: Point = makePoint(33.5588, 36.2765);

export interface SeedWorld {
  tenantId: string;
  customerId: string;
}

/** عالم لكل اختبار سباق: مستأجر مستقل = عزل RLS كامل (سائقو اختبار لا يلتقطهم غيره §6.1). */
export async function seedWorld(db: Db, opts: SeedTenantOpts = {}): Promise<SeedWorld> {
  const tenantId = await seedTenant(db, opts);
  await seedPricingRule(db, tenantId);
  const customerId = await seedCustomer(db, tenantId);
  return { tenantId, customerId };
}

export interface MakeOrderOpts {
  customerId: string;
  goodsAmount?: bigint;
  couponCode?: string;
  pickup?: Point;
  dropoff?: Point;
  service?: Service;
  /** true (افتراضي): transition إلى confirmed بفاعل staff — جاهز للإسناد (§5). */
  confirm?: boolean;
}

/**
 * طلب عبر مسار الإنتاج الوحيد createOrder (§10.1) ثم التأكيد عبر transition (D8) —
 * لا INSERT ولا UPDATE status خام إطلاقاً.
 */
export async function makeOrder(
  db: Db,
  tenantId: string,
  opts: MakeOrderOpts,
): Promise<{ order: Order; trackingToken: string }> {
  const input: CreateOrderInput = {
    service: opts.service ?? "food",
    customerId: opts.customerId,
    pickup: opts.pickup ?? DEFAULT_PICKUP,
    dropoff: opts.dropoff ?? DEFAULT_DROPOFF,
    ...(opts.goodsAmount !== undefined ? { goodsAmount: opts.goodsAmount } : {}),
    ...(opts.couponCode !== undefined ? { couponCode: opts.couponCode } : {}),
    createdBy: { type: "staff" },
  };
  const created = await createOrder(db, tenantId, input);
  if (opts.confirm === false) {
    return { order: created.order, trackingToken: created.trackingToken };
  }
  const confirmed = await doTransition(db, tenantId, {
    orderId: created.order.id,
    to: "confirmed",
    actor: { type: "staff" },
  });
  return { order: confirmed, trackingToken: created.trackingToken };
}

/** غلاف transition داخل withTenant — كل تغييرات الحالة بالاختبارات من هنا (D8). */
export async function doTransition(
  db: Db,
  tenantId: string,
  args: Parameters<typeof transition>[1],
): Promise<Order> {
  return withTenant(db, tenantId, (tx) => transition(tx, args));
}

// ————————————————————————— قراءات تحقق —————————————————————————

export async function fetchOrder(db: Db, tenantId: string, orderId: string): Promise<Order> {
  const rows = await withTenant(db, tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, orderId)));
  const row = rows[0];
  if (!row) {
    throw new Error(`fetchOrder: order ${orderId} not found`); // §16.12
  }
  return row;
}

export async function fetchOffer(db: Db, tenantId: string, offerId: string): Promise<Offer> {
  const rows = await withTenant(db, tenantId, (tx) => tx.select().from(offers).where(eq(offers.id, offerId)));
  const row = rows[0];
  if (!row) {
    throw new Error(`fetchOffer: offer ${offerId} not found`); // §16.12
  }
  return row;
}

/** أحداث الطلب بترتيب الوقوع (createdAt ثم id — uuidv7 يحفظ الترتيب داخل نفس اللحظة). */
export async function fetchOrderEvents(db: Db, tenantId: string, orderId: string): Promise<OrderEvent[]> {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
  );
}

export async function fetchLedgerForOrder(db: Db, tenantId: string, orderId: string): Promise<LedgerEntry[]> {
  return withTenant(db, tenantId, (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId)).orderBy(asc(ledgerEntries.createdAt)),
  );
}

export async function fetchLedgerForDriver(db: Db, tenantId: string, driverId: string): Promise<LedgerEntry[]> {
  return withTenant(db, tenantId, (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.driverId, driverId)).orderBy(asc(ledgerEntries.createdAt)),
  );
}

export async function fetchRedemptionsForCoupon(
  db: Db,
  tenantId: string,
  couponId: string,
): Promise<CouponRedemption[]> {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.couponId, couponId))
      .orderBy(asc(couponRedemptions.createdAt)),
  );
}

export async function fetchWallet(db: Db, tenantId: string, userId: string): Promise<{ points: number; wallet: bigint }> {
  return withTenant(db, tenantId, (tx) => loyaltyBalance(tx, tenantId, userId));
}

export async function fetchTrackingToken(
  db: Db,
  tenantId: string,
  token: string,
): Promise<{ token: string; orderId: string; expiresAt: Date }> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ token: trackingTokens.token, orderId: trackingTokens.orderId, expiresAt: trackingTokens.expiresAt })
      .from(trackingTokens)
      .where(and(eq(trackingTokens.tenantId, tenantId), eq(trackingTokens.token, token))),
  );
  const row = rows[0];
  if (!row) {
    throw new Error("fetchTrackingToken: token not found"); // §16.12
  }
  return row;
}

/** عدد طلبات زبون — يثبت أن ترانزاكشن إنشاء فاشلة (كوبون مستنفد) لم تترك طلباً وراءها. */
export async function countOrdersForCustomer(db: Db, tenantId: string, customerId: string): Promise<number> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select({ id: orders.id }).from(orders).where(eq(orders.customerId, customerId)),
  );
  return rows.length;
}

// ————————————————————————— أدوات فحص أخطاء pg —————————————————————————

export interface PgErrorInfo {
  code: string | null;
  constraint: string | null;
  message: string | null;
}

/**
 * drizzle 0.44 يلفّ خطأ pg بـ DrizzleQueryError (cause) — نمشي سلسلة الأسباب حتى أول
 * خطأ يحمل code (نفس نمط settlement.ts isPeriodUniqueViolation). 23514 = خرق CHECK،
 * 42501 = صلاحية مرفوضة (REVOKE)، P0001 = RAISE EXCEPTION من trigger، 40P01 = deadlock.
 */
export function pgError(error: unknown): PgErrorInfo {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const maybe = current as Error & { code?: unknown; constraint?: unknown };
    if (typeof maybe.code === "string") {
      return {
        code: maybe.code,
        constraint: typeof maybe.constraint === "string" ? maybe.constraint : null,
        message: maybe.message,
      };
    }
    current = current.cause;
  }
  return { code: null, constraint: null, message: error instanceof Error ? error.message : null };
}

export function fulfilledOf<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled").map((r) => r.value);
}

export function rejectedOf<T>(results: readonly PromiseSettledResult<T>[]): unknown[] {
  return results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
}
