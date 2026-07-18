import {
  PLAN_DRIVER_LIMITS,
  planAllowsDriverCount,
  tenantDay,
  type DriverStatus,
  type TenantPlan,
  type TenantStatus,
  type Vehicle,
} from "@quickdrop/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  auditLog,
  drivers,
  orders,
  tenantPayments,
  tenants,
  users,
  type Tenant,
  type TenantPayment,
} from "./schema/index.js";
import { withTenant, type Tx } from "./with-tenant.js";

// §14 v1.1 — فرض الباقات ودورة حياة المستأجر. مصدر السقوف الوحيد PLAN_DRIVER_LIMITS
// (@quickdrop/shared، مُختبَر نقياً)؛ نُعيد تصديره ليُبنى عليه بطبقة القاعدة أيضاً.
export { PLAN_DRIVER_LIMITS } from "@quickdrop/shared";

/** معرّف المستأجر مدخل مستخدم (§11) — غير موجود = حالة عمل (404 بالـ API)، لا باغ. */
export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`tenant ${tenantId} not found`);
    this.name = "TenantNotFoundError";
  }
}

// ————————————————————————— فرض الباقات (§14) —————————————————————————

/**
 * §14 — هل يسمح حد الباقة بتفعيل سائق إضافي الآن؟ العدّ يشمل كل السائقين
 * (drivers بلا soft-delete بـ v1 — لا عمود deleted_at؛ الحالة offline/online فقط،
 * لا "محذوف"). تُستدعى داخل ترانزاكشن مستأجر قائمة (withTenant). المنطق الصافي
 * (planAllowsDriverCount) بـ @quickdrop/shared — هنا فقط العدّ من القاعدة.
 */
export async function canActivateDriver(tx: Tx, tenantId: string, plan: TenantPlan): Promise<boolean> {
  const rows = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(drivers)
    .where(eq(drivers.tenantId, tenantId));
  const current = rows[0]?.n;
  if (current === undefined) {
    throw new Error("canActivateDriver: count query returned no row"); // §16.12
  }
  return planAllowsDriverCount(plan, current);
}

/** §3 v1.1 — مدخلات إنشاء سائق: userId (حساب موجود) أو phone (يُنشأ مستخدم دور driver). */
export interface CreateDriverInput {
  vehicle: Vehicle;
  /** ربط بحساب users قائم (تيليغرام مثلاً). */
  userId?: string;
  /** بديل userId — رقم E.164 مطبَّع مسبقاً (البحث/الإنشاء لمستخدم دور driver). */
  phone?: string;
  /** اسم يُملأ عند إنشاء مستخدم جديد بالهاتف. */
  name?: string;
}

/** §14/§6 — نتيجة إنشاء السائق (نمط النتائج المُميَّزة، كـ dispatch): الـ API يترجمها لـ HTTP. */
export type CreateDriverResult =
  | { outcome: "created"; driver: { id: string; vehicle: Vehicle; status: DriverStatus } }
  | { outcome: "already_driver"; driver: { id: string; vehicle: Vehicle; status: DriverStatus } }
  | { outcome: "plan_limit"; plan: TenantPlan; limit: number; current: number }
  | { outcome: "user_not_found" };

// D15 — البحث/الإنشاء لمستخدم دور driver بالهاتف (نفس فلسفة findOrCreateCustomer):
// فهرس (tenant_id, phone_e164)؛ غير موجود = إنشاء بـ telegram_user_id NULL. سباق
// إنشاء متزامن لنفس الرقم قد يخلق صفين (لا قيد فريد على الهاتف) — مقبول لشاشة يدوية.
async function findOrCreateDriverUser(tx: Tx, tenantId: string, phoneE164: string, firstName?: string): Promise<string> {
  const existing = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.phoneE164, phoneE164), eq(users.role, "driver")))
    .orderBy(users.createdAt) // حتمية الاختيار: الأقدم
    .limit(1);
  const found = existing[0];
  if (found) return found.id;

  const inserted = await tx
    .insert(users)
    .values({
      tenantId,
      role: "driver",
      phoneE164,
      telegramUserId: null, // سائق بلا تيليغرام (يُربط لاحقاً ببوت السائق)
      ...(firstName !== undefined ? { firstName } : {}),
    })
    .returning({ id: users.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("findOrCreateDriverUser: INSERT users ... RETURNING returned no row"); // §16.12
  }
  return row.id;
}

/**
 * §14 — إنشاء/تفعيل سائق مع فرض حد الباقة ذرّياً. ترانزاكشن withTenant واحدة:
 *   1) §16.11 — قفل صف المستأجر FOR UPDATE: مرساة تسلسل تمنع تفعيلين متزامنين
 *      يتجاوزان الحد معاً، وتقرأ الباقة تحت القفل (tenants استثناء RLS §2.3).
 *   2) حلّ المستخدم: userId قائم (وإلا user_not_found) أو phone (بحث/إنشاء دور driver).
 *   3) سائق موجود لنفس المستخدم = already_driver (idempotent — لا تكرار ولا عدّ مزدوج).
 *   4) §14 — فحص الحد (planAllowsDriverCount على العدّ الحالي): تجاوز → plan_limit
 *      (الـ API يردّ 409 برسالة ترقية، لا فشل صامت).
 *   5) INSERT drivers (status='offline' افتراضاً).
 */
export async function createDriver(db: Db, tenantId: string, input: CreateDriverInput): Promise<CreateDriverResult> {
  if (input.userId === undefined && input.phone === undefined) {
    // باغ مستدعٍ: الـ API يفرض بـ Zod وجود أحدهما حصراً قبل الوصول هنا (§11).
    throw new TypeError("createDriver: either userId or phone is required");
  }
  return withTenant(db, tenantId, async (tx) => {
    const tenantRows = await tx
      .select({ id: tenants.id, plan: tenants.plan })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for("update");
    const tenant = tenantRows[0];
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }

    // 2) حلّ المستخدم
    let userId: string;
    if (input.userId !== undefined) {
      const userRows = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId)))
        .limit(1);
      const user = userRows[0];
      if (!user) {
        return { outcome: "user_not_found" } as const; // معرّف مدخل مستخدم (§11) — 404 بالـ API
      }
      userId = user.id;
    } else if (input.phone !== undefined) {
      userId = await findOrCreateDriverUser(tx, tenantId, input.phone, input.name);
    } else {
      // مستحيل (الحارس أعلى الدالة) — يرضي المدقّق بلا تأكيد non-null
      throw new TypeError("createDriver: either userId or phone is required");
    }

    // 3) سائق قائم لهذا المستخدم = نجاح idempotent (لا يُحتسب مرتين على الحد)
    const existingDriver = await tx
      .select({ id: drivers.id, vehicle: drivers.vehicle, status: drivers.status })
      .from(drivers)
      .where(and(eq(drivers.tenantId, tenantId), eq(drivers.userId, userId)))
      .limit(1);
    const already = existingDriver[0];
    if (already) {
      return { outcome: "already_driver", driver: already } as const;
    }

    // 4) §14 — فرض حد الباقة تحت قفل المستأجر (العدّ ثم planAllowsDriverCount — عدّة واحدة)
    const countRows = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(drivers)
      .where(eq(drivers.tenantId, tenantId));
    const current = countRows[0]?.n;
    if (current === undefined) {
      throw new Error("createDriver: driver count query returned no row"); // §16.12
    }
    if (!planAllowsDriverCount(tenant.plan, current)) {
      return { outcome: "plan_limit", plan: tenant.plan, limit: PLAN_DRIVER_LIMITS[tenant.plan], current } as const;
    }

    // 5) الإدراج
    const inserted = await tx
      .insert(drivers)
      .values({ tenantId, userId, vehicle: input.vehicle })
      .returning({ id: drivers.id, vehicle: drivers.vehicle, status: drivers.status });
    const row = inserted[0];
    if (!row) {
      throw new Error("createDriver: INSERT drivers ... RETURNING returned no row"); // §16.12
    }
    return { outcome: "created", driver: row } as const;
  });
}

// ————————————————————————— دورة حياة المستأجر (§14) —————————————————————————

// §3/§10.2 — audit_log يفرض فاعلاً (CHECK actor_staff_id OR actor_admin_id NOT NULL)
// وactor_admin_id بمفتاح أجنبي إلى admin_users. حتى يُبنى دخول المشرف الكامل (§10.2)،
// نكتب صف تدقيق فقط حين يمرّر المستدعي byAdminId صالحاً؛ غيابه → لوغ منظّم (§13) بلا
// صف مزيّف يخرق الـ CHECK/FK. يُستدعى داخل ترانزاكشن مستأجر (RLS على audit_log §2.3).
async function recordAdminAudit(
  tx: Tx,
  tenantId: string,
  entry: { action: string; entity: string; entityId: string; before: unknown; after: unknown },
  byAdminId: string | undefined,
): Promise<void> {
  if (byAdminId === undefined) {
    console.log(
      JSON.stringify({ action: entry.action, tenant_id: tenantId, actor: "admin", audit: "skipped_no_admin_id" }),
    );
    return;
  }
  await tx.insert(auditLog).values({
    tenantId,
    actorAdminId: byAdminId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  });
}

export interface SetTenantStatusOptions {
  /** سبب الإيقاف — يُخزَّن بـ tenants.suspended_reason عند status='suspended' فقط. */
  reason?: string;
  /** المشرف الفاعل — يوقّع audit_log؛ غيابه = تدقيق مؤجّل (§10.2 لاحقاً). */
  byAdminId?: string;
}

/**
 * §14 — تغيير حالة المستأجر (trial→active→past_due→suspended→churned). المشرف سلطة
 * التجاوز (يعيد suspended→active مثلاً)، فالتحقق من صحة القيمة بـ Zod عند الـ API لا
 * جدول انتقالات صارم هنا. ترانزاكشن withTenant واحدة: قفل صف المستأجر FOR UPDATE
 * (§16.11 قراءة-ثم-كتابة على حالة) → UPDATE status (+ suspended_reason) → audit_log.
 * suspended_reason يُملأ عند الإيقاف ويُمحى عند مغادرته (لا سبب متقادم يبقى).
 */
export async function setTenantStatus(
  db: Db,
  tenantId: string,
  status: TenantStatus,
  opts: SetTenantStatusOptions = {},
): Promise<Tenant> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
    const tenant = rows[0];
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }
    const from = tenant.status;
    const now = new Date(); // D6: UTC
    const suspendedReason = status === "suspended" ? (opts.reason ?? null) : null;

    const updated = await tx
      .update(tenants)
      .set({ status, suspendedReason, updatedAt: now })
      .where(eq(tenants.id, tenantId))
      .returning();
    const next = updated[0];
    if (!next) {
      throw new Error("setTenantStatus: UPDATE tenants ... RETURNING returned no row"); // §16.12
    }

    await recordAdminAudit(
      tx,
      tenantId,
      {
        action: "tenant.status_changed",
        entity: "tenant",
        entityId: tenantId,
        before: { status: from },
        after: { status, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) },
      },
      opts.byAdminId,
    );
    // §13 — لوغ منظّم بلا PII (السبب قد يكون نصاً حراً — محفوظ بالقاعدة للتدقيق فقط)
    console.log(JSON.stringify({ action: "tenant_status_changed", tenant_id: tenantId, from, to: status }));
    return next;
  });
}

/**
 * §14 — تمديد الفترة التجريبية. الأساس = trial_ends_at إن كان مستقبلاً وإلا الآن
 * (تمديد فترة منتهية يبدأ من اليوم لا من الماضي)، + days يوماً. لا يغيّر status —
 * المشرف يعيد التفعيل بـ setTenantStatus صراحةً إن لزم.
 */
export async function extendTrial(
  db: Db,
  tenantId: string,
  days: number,
  byAdminId?: string,
): Promise<Tenant> {
  if (!Number.isInteger(days) || days <= 0) {
    // باغ مستدعٍ: الـ API يفرض عدداً صحيحاً موجباً بـ Zod قبل الوصول هنا (§11).
    throw new RangeError("extendTrial: days must be a positive integer");
  }
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
    const tenant = rows[0];
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }
    const now = new Date(); // D6: UTC
    const base =
      tenant.trialEndsAt !== null && tenant.trialEndsAt.getTime() > now.getTime() ? tenant.trialEndsAt : now;
    const newEnd = new Date(base.getTime() + days * 86_400_000);

    const updated = await tx
      .update(tenants)
      .set({ trialEndsAt: newEnd, updatedAt: now })
      .where(eq(tenants.id, tenantId))
      .returning();
    const next = updated[0];
    if (!next) {
      throw new Error("extendTrial: UPDATE tenants ... RETURNING returned no row"); // §16.12
    }

    await recordAdminAudit(
      tx,
      tenantId,
      {
        action: "tenant.trial_extended",
        entity: "tenant",
        entityId: tenantId,
        before: { trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null },
        after: { trialEndsAt: newEnd.toISOString(), days },
      },
      byAdminId,
    );
    console.log(JSON.stringify({ action: "tenant_trial_extended", tenant_id: tenantId, days }));
    return next;
  });
}

export interface RecordTenantPaymentInput {
  /** D5 — مال bigint بأصغر وحدة، > 0. */
  amount: bigint;
  periodNote?: string;
  /** من استلم الدفعة (اسم/معرّف المشرف) — نص حر بـ v1 حتى دخول المشرف الكامل (§10.2). */
  receivedBy?: string;
}

/**
 * §14 — تسجيل تحصيل يدوي من المستأجر. منذ ترحيل 0012 الجدول تحت FORCE RLS كغيره
 * (MERGE_PLAN R-02 — الاستثناء القديم كان ثغرة تسريب بين المستأجرين): التحقق من
 * وجود المستأجر خارج السياق (tenants بلا RLS قصداً)، والإدراج داخل
 * withTenant(tenantId). append-only عملياً — لا تعديل بعد الإدراج.
 */
export async function recordTenantPayment(
  db: Db,
  tenantId: string,
  input: RecordTenantPaymentInput,
): Promise<TenantPayment> {
  if (input.amount <= 0n) {
    // باغ مستدعٍ: الـ API يفرض amount موجباً بـ Zod (§11) قبل الوصول هنا.
    throw new RangeError("recordTenantPayment: amount must be a positive bigint");
  }
  const tenantRows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenantRows[0]) {
    throw new TenantNotFoundError(tenantId);
  }
  const row = await withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(tenantPayments)
      .values({
        tenantId,
        amount: input.amount,
        ...(input.periodNote !== undefined ? { periodNote: input.periodNote } : {}),
        ...(input.receivedBy !== undefined ? { receivedBy: input.receivedBy } : {}),
      })
      .returning();
    const first = inserted[0];
    if (!first) {
      throw new Error("recordTenantPayment: INSERT tenant_payments ... RETURNING returned no row"); // §16.12
    }
    return first;
  });
  console.log(JSON.stringify({ action: "tenant_payment_recorded", tenant_id: tenantId }));
  return row;
}

/** §14 — صف صحّة المستأجر بكونسول المشرف: نبض النشاط + الباقة/الحالة + عدد السائقين. */
export interface TenantHealthRow {
  id: string;
  slug: string;
  name: string;
  plan: TenantPlan;
  status: TenantStatus;
  trialEndsAt: Date | null;
  driverCount: number;
  ordersToday: number;
  lastOrderAt: Date | null;
}

/**
 * §14 — صحّة كل المستأجرين لكونسول المشرف. tenants جدول منصة (استثناء RLS §2.3):
 * قراءة مباشرة، ثم لكل مستأجر withTenant لعدّاداته (طلبات اليوم بمنطقته عبر tenantDay
 * §16.8، آخر طلب، عدد السائقين).
 *
 * TODO(§2.3): هذا N+1 على مستوى المستأجرين — v1 بسّط (عدد المستأجرين عشرات). لاحقاً
 * يُستبدل باستعلام واحد بدور platform (BYPASSRLS مخصص للمشرف) بدل حلقة withTenant.
 */
export async function listTenantsHealth(db: Db): Promise<TenantHealthRow[]> {
  const tenantRows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      plan: tenants.plan,
      status: tenants.status,
      trialEndsAt: tenants.trialEndsAt,
      timezone: tenants.timezone,
    })
    .from(tenants)
    .orderBy(tenants.createdAt);

  const now = new Date(); // D6: UTC — لحظة واحدة لكل الصفوف (اتساق)
  const result: TenantHealthRow[] = [];
  for (const t of tenantRows) {
    const today = tenantDay(t.timezone, now); // الفخ 8: "اليوم" بمنطقة المستأجر لا UTC

    const counters = await withTenant(db, t.id, async (tx) => {
      const orderAgg = await tx
        .select({
          // §16.8 — تحويل created_at لمنطقة المستأجر ثم مقارنة اليوم (لا نافذة UTC)
          ordersToday: sql<number>`count(*) filter (
            where (${orders.createdAt} at time zone ${t.timezone})::date = ${today}::date
          )`.mapWith(Number),
          lastOrderAt: sql<Date | null>`max(${orders.createdAt})`,
        })
        .from(orders)
        .where(and(eq(orders.tenantId, t.id), isNull(orders.deletedAt))); // D10: المحذوف ناعماً لا يُحتسب

      const driverAgg = await tx
        .select({ driverCount: sql<number>`count(*)`.mapWith(Number) })
        .from(drivers)
        .where(eq(drivers.tenantId, t.id));

      const o = orderAgg[0];
      const d = driverAgg[0];
      if (!o || !d) {
        throw new Error(`listTenantsHealth: aggregate returned no row for tenant ${t.id}`); // §16.12
      }
      return { ordersToday: o.ordersToday, lastOrderAt: o.lastOrderAt, driverCount: d.driverCount };
    });

    result.push({
      id: t.id,
      slug: t.slug,
      name: t.name,
      plan: t.plan,
      status: t.status,
      trialEndsAt: t.trialEndsAt,
      driverCount: counters.driverCount,
      ordersToday: counters.ordersToday,
      lastOrderAt: counters.lastOrderAt,
    });
  }
  return result;
}
