import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { drivers, ledgerEntries, settlements, users, type Settlement } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §8.2 v1.1 — التسوية اليومية. المبدأ (§8.1): رصيد السائق = SUM(amount) لقيوده —
// لا عمود balance يُحدَّث. "إغلاق اليوم" = صف settlements مغلق + قيد remitted سالب
// بالمستلَم الفعلي؛ الفرق يظهر حسابياً ولا يُخفى. ledger_entries append-only —
// الاستثناء الوحيد المسموح بعد الإدراج هو ربط settlement_id (trigger 0003 §8.2).

/** §8.2 — صف شاشة التسوية: سائق واحد له قيود غير مسوّاة (settlement_id IS NULL). */
export interface SettlementBoardRow {
  driverId: string;
  /** اسم السائق (users.first_name عبر drivers.user_id) — قد يكون NULL. */
  name: string | null;
  /** المتوقَّع = SUM(amount) لقيوده غير المسوّاة (§8.1: الرصيد مجموع، لا عمود). */
  expected: bigint;
  entryCount: number;
  lastEntryAt: Date;
}

/**
 * §8.2 — لوحة التسوية: صف لكل سائق عنده قيود غير مسوّاة. استعلام واحد
 * (§16.10: لا N+1 — join/تجميع واحد، لا استعلام لكل سائق).
 * الترتيب: الأثقل ذمةً أولاً (الموزّع يبدأ بمن معه أكبر كاش) ثم driverId للحتمية.
 */
export async function getSettlementBoard(db: Db, tenantId: string): Promise<SettlementBoardRow[]> {
  // D5 — sum(BIGINT) يصل numeric نصياً من الدرايفر: bigint بالتطبيق، لا Number (الفخ 1)
  const expectedExpr = sql<bigint>`sum(${ledgerEntries.amount})`.mapWith((value) => BigInt(String(value)));
  const entryCountExpr = sql<number>`count(*)::int`.mapWith(Number);
  // D6 — timestamptz يصل Date من node-postgres؛ التطبيع دفاعي فقط
  const lastEntryAtExpr = sql<Date>`max(${ledgerEntries.createdAt})`.mapWith((value) =>
    value instanceof Date ? value : new Date(String(value)),
  );

  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        driverId: ledgerEntries.driverId,
        name: users.firstName,
        expected: expectedExpr,
        entryCount: entryCountExpr,
        lastEntryAt: lastEntryAtExpr,
      })
      .from(ledgerEntries)
      .innerJoin(
        drivers,
        and(eq(drivers.tenantId, ledgerEntries.tenantId), eq(drivers.id, ledgerEntries.driverId)),
      )
      .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
      // فوق RLS — يقود فهرس (tenant_id, settlement_id)
      .where(and(eq(ledgerEntries.tenantId, tenantId), isNull(ledgerEntries.settlementId)))
      .groupBy(ledgerEntries.driverId, users.id, users.firstName)
      .orderBy(desc(expectedExpr), asc(ledgerEntries.driverId)),
  );

  return rows.map((r) => ({
    driverId: r.driverId,
    name: r.name,
    expected: r.expected,
    entryCount: r.entryCount,
    lastEntryAt: r.lastEntryAt,
  }));
}

export interface CloseSettlementInput {
  driverId: string;
  /** YYYY-MM-DD بمنطقة المستأجر — المستدعي يحسبها بـ tenantDay (§16.8 الفخ 8)، لا new Date() خام. */
  periodDate: string;
  /** المستلَم فعلياً من السائق (D5: bigint، ≥ 0). */
  received: bigint;
  /** أمان مؤقت: يُملأ مع staff auth الحقيقي (§10.2) — يوقّع settlements.closed_by وقيد remitted. */
  staffId?: string;
}

/** §8.2 — unique (tenant, driver, period_date): اليوم مقفول لهذا السائق — ليس باغاً، حالة عمل (409 بالـ API). */
export class SettlementDayClosedError extends Error {
  constructor(driverId: string, periodDate: string) {
    super(`settlement for driver ${driverId} on ${periodDate} is already closed`);
    this.name = "SettlementDayClosedError";
  }
}

/** معرّف السائق مدخل مستخدم (§11) — غير موجود (أو محجوب بـ RLS) = حالة عمل (404)، لا باغ. */
export class SettlementDriverNotFoundError extends Error {
  constructor(driverId: string) {
    super(`driver ${driverId} not found`);
    this.name = "SettlementDriverNotFoundError";
  }
}

const PERIOD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// pg يرمي 23505 عند خرق unique؛ drizzle 0.44 يلفّه بـ DrizzleQueryError (cause).
// نطابق اسم القيد حصراً — 23505 على قيد آخر هنا حالة مستحيلة تستحق إعادة الرمي (§16.12).
function isPeriodUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const maybe = current as { code?: unknown; constraint?: unknown };
    if (maybe.code === "23505" && maybe.constraint === "settlements_tenant_driver_period_uq") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * §8.2 — إغلاق يوم سائق: ترانزاكشن withTenant واحدة —
 *   1) قفل صف السائق FOR UPDATE — مرساة تسلسل (§16.11): إغلاقان متزامنان لنفس
 *      السائق يتسلسلان هنا، والثاني يفشل بوضوح على unique (tenant, driver, period_date).
 *   2) جمع قيوده غير المسوّاة FOR UPDATE (قيد يُدرَج بعد لقطتنا يبقى لتسوية لاحقة —
 *      transition() لا يمس صف السائق فلا deadlock).
 *   3) expected = SUM(amount) (§8.1: الرصيد مجموع، لا عمود).
 *   4) INSERT settlements (expected/received/diff = expected − received, status='closed').
 *   5) received > 0 → قيد remitted بمبلغ −received مربوطاً بالتسوية مباشرة
 *      (§8.2: الفرق يظهر حسابياً ولا يُخفى؛ received=0 → لا قيد — CHECK الإشارة يطلب سالباً).
 *   6) UPDATE settlement_id على القيود المجمَّعة — التعديل الوحيد المسموح بالـ trigger.
 * بعد الإغلاق ممنوع أي UPDATE — التصحيح قيد adjustment جديد بتوقيع staff (§8.2).
 */
export async function closeDriverSettlement(
  db: Db,
  tenantId: string,
  input: CloseSettlementInput,
): Promise<Settlement> {
  if (input.received < 0n) {
    // المستلَم مبلغ كاش مُسلَّم — سالبه باغ مستدعٍ (الـ API يرفضه 400 قبل الوصول هنا)
    throw new RangeError("closeDriverSettlement: received must be non-negative");
  }
  if (!PERIOD_DATE_RE.test(input.periodDate)) {
    throw new RangeError("closeDriverSettlement: periodDate must be YYYY-MM-DD (tenantDay §16.8)");
  }

  return withTenant(db, tenantId, async (tx) => {
    // 1) §16.11 — قراءة-ثم-كتابة على حالة = قفل صف: السائق هو مرساة التسلسل
    const driverRows = await tx
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.id, input.driverId))
      .for("update");
    if (!driverRows[0]) {
      throw new SettlementDriverNotFoundError(input.driverId);
    }

    // 2) القيود غير المسوّاة FOR UPDATE — تُجمَّد لقطتها حتى ربطها بالتسوية
    const entryRows = await tx
      .select({ id: ledgerEntries.id, amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.driverId, input.driverId), isNull(ledgerEntries.settlementId)))
      .for("update");

    // 3) §8.1 — المتوقَّع = مجموع القيود (bigint حصراً — D5)
    let expected = 0n;
    for (const entry of entryRows) {
      expected += entry.amount;
    }

    // 4) صف التسوية المغلق — الفرق عمود محسوب هنا ويثبت للأبد (8.3-3)
    const now = new Date(); // D6: UTC
    let inserted: Settlement[];
    try {
      inserted = await tx
        .insert(settlements)
        .values({
          tenantId,
          driverId: input.driverId,
          periodDate: input.periodDate,
          expected,
          received: input.received,
          diff: expected - input.received,
          status: "closed",
          closedBy: input.staffId ?? null,
          closedAt: now,
        })
        .returning();
    } catch (error) {
      if (isPeriodUniqueViolation(error)) {
        // §16.7 — ضغطة مكررة/إغلاقان متزامنان: خطأ واضح، والترانزاكشن كلها rollback
        throw new SettlementDayClosedError(input.driverId, input.periodDate);
      }
      throw error; // §16.12 — لا ابتلاع
    }
    const settlement = inserted[0];
    if (!settlement) {
      throw new Error("closeDriverSettlement: INSERT settlements ... RETURNING returned no row"); // §16.12
    }

    // 5) §8.2 — قيد الاستلام: سالب بالمستلَم الفعلي، مربوط بالتسوية منذ الإدراج
    //    (الـ trigger يمنع تعديل ما عدا settlement_id بعد الإدراج — لا حاجة لتعديل أصلاً)
    if (input.received > 0n) {
      await tx.insert(ledgerEntries).values({
        tenantId,
        driverId: input.driverId,
        entryType: "remitted",
        amount: -input.received,
        settlementId: settlement.id,
        createdBy: input.staffId ?? null,
      });
    }

    // 6) ربط القيود المجمَّعة — UPDATE على settlement_id فقط (المسموح الوحيد §8.2)
    if (entryRows.length > 0) {
      await tx
        .update(ledgerEntries)
        .set({ settlementId: settlement.id })
        .where(
          inArray(
            ledgerEntries.id,
            entryRows.map((entry) => entry.id),
          ),
        );
    }

    return settlement;
  });
}
