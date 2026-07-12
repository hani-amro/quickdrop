import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makePoint,
  SERVICES,
  toPostgisWkt,
  type Point,
  type Service,
  type UserRole,
} from "@quickdrop/shared";
import { Algorithm, hash } from "@node-rs/argon2";
import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  drivers,
  pricingRules,
  staff,
  tenants,
  users,
  withTenant,
  zones,
  type Tx,
} from "../src/index.js";

// §10.2 — نفس معايير argon2id في apps/api/src/auth/hashing.ts (OWASP: m=19MiB, t=2, p=1).
const DEMO_STAFF = { email: "owner@demo.local", password: "demo1234", role: "owner" as const };

async function ensureStaff(tx: Tx, tenantId: string): Promise<"created" | "existing"> {
  const existing = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.email, DEMO_STAFF.email)))
    .limit(1);
  if (existing[0]) return "existing";
  const passwordHash = await hash(DEMO_STAFF.password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await tx.insert(staff).values({
    tenantId,
    email: DEMO_STAFF.email,
    passwordHash,
    role: DEMO_STAFF.role,
  });
  return "created";
}

// seed تجريبي للمعاينة المحلية (DX) — idempotent: تشغيله مرتين لا يكرر صفوفاً.
// مستأجر demo بلا بوت (حقول البوت NULL): الداشبورد والـ API يعملان بلا تيليغرام —
// الربط لاحقاً عبر tenant:provision (§14). المستأجر يُنشأ بلا سياق (tenants استثناء
// RLS مسمّى §2.4)، وكل الباقي عبر withTenant (§2.2) بدور app_user (DATABASE_URL).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// DX: حمّل .env من جذر الريبو إن وُجد — env الشِل لها الأسبقية (سلوك Node نفسه:
// loadEnvFile لا يكتب فوق متغير موجود). الفحص explicit — لا ابتلاع أخطاء (§16.12).
const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// روح الفخ 24: بيانات تجريبية ممنوعة على بيئة إنتاج — الفحص بعد تحميل .env
// (يمسك NODE_ENV من الشِل ومن الملف معاً) والرفض بصوت عالٍ.
if (process.env["NODE_ENV"] === "production") {
  console.error(
    "seed-dev REFUSED: NODE_ENV=production — هذا seed تجريبي ولا يعمل على بيئة إنتاج (روح الفخ 24)",
  );
  process.exit(1);
}

const DEMO_SLUG = "demo";
const ZONE_NAME = "دمشق";

// D7: WKT بترتيب (lng lat)، الحلقة مغلقة (النقطة الأولى = الأخيرة) —
// مربع حول دمشق: lat 33.35→33.65، lng 36.10→36.45.
const DAMASCUS_POLYGON_WKT =
  "POLYGON((36.10 33.35, 36.45 33.35, 36.45 33.65, 36.10 33.65, 36.10 33.35))";

interface PersonSeed {
  firstName: string;
  phoneE164: string;
}

// D15: زبونا تلفون — telegram_user_id يبقى NULL.
const CUSTOMER_SEEDS: readonly PersonSeed[] = [
  { firstName: "سامر", phoneE164: "+963944000001" },
  { firstName: "لينا", phoneE164: "+963944000002" },
];

// نقاط السائقين داخل منطقة دمشق (makePoint(lat, lng) — الفخ 6: لا أزواج أرقام عارية).
const DRIVER_SEEDS: readonly (PersonSeed & { point: Point })[] = [
  { firstName: "أحمد", phoneE164: "+963955000001", point: makePoint(33.51, 36.29) },
  { firstName: "خالد", phoneE164: "+963955000002", point: makePoint(33.52, 36.31) },
];

type EnsureOutcome = "created" | "existing";

async function ensureZone(tx: Tx, tenantId: string): Promise<EnsureOutcome> {
  // لا قيد فريد على (tenant_id, name) — العَود بفحص وجود بالاسم؛ seed أحادي العملية.
  const found = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.tenantId, tenantId), eq(zones.name, ZONE_NAME)))
    .limit(1);
  if (found[0]) return "existing";
  await tx.insert(zones).values({ tenantId, name: ZONE_NAME, polygon: DAMASCUS_POLYGON_WKT });
  return "created";
}

async function ensurePricingRule(tx: Tx, tenantId: string, service: Service): Promise<EnsureOutcome> {
  // قاعدة عامة واحدة لكل خدمة (zone_id NULL) — قاعدة قائمة لا تُلمس (تعديلات المستخدم تبقى).
  const found = await tx
    .select({ id: pricingRules.id })
    .from(pricingRules)
    .where(
      and(eq(pricingRules.tenantId, tenantId), eq(pricingRules.service, service), isNull(pricingRules.zoneId)),
    )
    .limit(1);
  if (found[0]) return "existing";
  await tx.insert(pricingRules).values({
    tenantId,
    service,
    base: 5000n, // D5: bigint بأصغر وحدة (قرش سوري)
    perKm: 1500n,
    perKg: 500n,
    minTotal: 8000n,
    surgeMultiplierBp: 10000, // ×1.0
    priority: 0,
  });
  return "created";
}

async function ensureUser(
  tx: Tx,
  tenantId: string,
  role: UserRole,
  seed: PersonSeed,
): Promise<{ userId: string; outcome: EnsureOutcome }> {
  // لا قيد فريد على الهاتف — مفتاح العَود الطبيعي للـ seed: (المستأجر، الدور، الهاتف).
  const found = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, role), eq(users.phoneE164, seed.phoneE164)))
    .limit(1);
  const existing = found[0];
  if (existing) return { userId: existing.id, outcome: "existing" };
  const inserted = await tx
    .insert(users)
    .values({ tenantId, role, phoneE164: seed.phoneE164, firstName: seed.firstName })
    .returning({ id: users.id });
  const row = inserted[0];
  if (!row) throw new Error("seed-dev: users insert returned no row");
  return { userId: row.id, outcome: "created" };
}

async function ensureDriver(
  tx: Tx,
  tenantId: string,
  userId: string,
  point: Point,
): Promise<"created" | "refreshed"> {
  const now = new Date();
  // §16.11: قراءة-ثم-كتابة = FOR UPDATE — حتى بالـ seed، العادة واحدة بكل مكان.
  const found = await tx
    .select({ id: drivers.id })
    .from(drivers)
    .where(and(eq(drivers.tenantId, tenantId), eq(drivers.userId, userId)))
    .limit(1)
    .for("update");
  const existing = found[0];
  if (existing) {
    // إنعاش المعاينة بلا تكرار صفوف: طزاجة الموقع شرط الترشيح (§6.1 — أحدث من
    // دقيقتين)، فإعادة تشغيل الـ seed تعيد السائقين online بموقع ووردية طازجين.
    await tx
      .update(drivers)
      .set({
        status: "online",
        lastPoint: toPostgisWkt(point), // D7: WKT بترتيب lng lat
        lastPointAt: now,
        shiftStartedAt: now,
        updatedAt: now,
      })
      .where(and(eq(drivers.tenantId, tenantId), eq(drivers.id, existing.id)));
    return "refreshed";
  }
  await tx.insert(drivers).values({
    tenantId,
    userId,
    vehicle: "motorbike",
    status: "online", // D14: لا حالة busy — الانشغال يُشتق من الطلبات النشطة
    maxConcurrentOrders: 2,
    lastPoint: toPostgisWkt(point),
    lastPointAt: now,
    shiftStartedAt: now,
  });
  return "created";
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required (app_user)");

  const handle = createDb(url);
  try {
    // المستأجر: onConflictDoNothing على slug — إعادة التشغيل لا تكرر صفاً ولا تمسح
    // ربط بوت أُضيف لاحقاً عبر tenant:provision. حقول البوت تبقى NULL عمداً.
    const insertedTenant = await handle.db
      .insert(tenants)
      .values({ slug: DEMO_SLUG, name: "Demo Office", nameAr: "مكتب التجربة" })
      .onConflictDoNothing({ target: tenants.slug })
      .returning({ id: tenants.id });
    const tenantOutcome: EnsureOutcome = insertedTenant[0] ? "created" : "existing";
    const foundTenant = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, DEMO_SLUG))
      .limit(1);
    const tenant = insertedTenant[0] ?? foundTenant[0];
    if (!tenant) throw new Error("seed-dev: demo tenant missing after upsert");

    const summary = await withTenant(handle.db, tenant.id, async (tx) => {
      const zoneOutcome = await ensureZone(tx, tenant.id);

      const rules = { created: 0, existing: 0 };
      for (const service of SERVICES) {
        rules[await ensurePricingRule(tx, tenant.id, service)] += 1;
      }

      const customers = { created: 0, existing: 0 };
      for (const seed of CUSTOMER_SEEDS) {
        customers[(await ensureUser(tx, tenant.id, "customer", seed)).outcome] += 1;
      }

      const driverCounts = { created: 0, refreshed: 0 };
      for (const seed of DRIVER_SEEDS) {
        const { userId } = await ensureUser(tx, tenant.id, "driver", seed);
        driverCounts[await ensureDriver(tx, tenant.id, userId, seed.point)] += 1;
      }

      const staffOutcome = await ensureStaff(tx, tenant.id);

      return { zoneOutcome, rules, customers, driverCounts, staffOutcome };
    });

    // الملخص أسماء وأعداد فقط — لا معرّفات ولا هواتف (§11).
    console.log(
      JSON.stringify(
        {
          action: "seed_dev",
          tenant: { slug: DEMO_SLUG, name: "Demo Office", outcome: tenantOutcome },
          zone: { name: ZONE_NAME, outcome: summary.zoneOutcome },
          pricingRules: { services: SERVICES, ...summary.rules },
          customers: { names: CUSTOMER_SEEDS.map((c) => c.firstName), ...summary.customers },
          drivers: { names: DRIVER_SEEDS.map((d) => d.firstName), ...summary.driverCounts },
          staff: { email: DEMO_STAFF.email, outcome: summary.staffOutcome }, // كلمة السر بالـ README
        },
        null,
        2,
      ),
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
