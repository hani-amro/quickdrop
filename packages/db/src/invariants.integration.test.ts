import { newId, toPostgisWkt } from "@quickdrop/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, ledgerEntries, orderEvents, orders } from "./schema/index.js";
import { closeDriverSettlement } from "./settlement.js";
import {
  DEFAULT_DROPOFF,
  DEFAULT_PICKUP,
  closeHarness,
  connectHarness,
  fetchOrderEvents,
  hasDb,
  makeOrder,
  pgError,
  resetDb,
  seedDriver,
  seedStaff,
  seedWorld,
  type PgErrorInfo,
  type TestHarness,
} from "./test-helpers.js";
import { withTenant } from "./with-tenant.js";

// §15 + §16.14 — قيود القاعدة «تعمل فعلاً» لا تعليمات: CHECK الإشارة لكل نوع قيد (§8.1)،
// append-only على order_events/ledger_entries (trigger 0003 + REVOKE — طبقتا دفاع)،
// معادلة السعر (§8.3-1)، وفاعل audit_log الإلزامي (§3). نؤكد رمز الخطأ واسم القيد —
// 23514 = خرق CHECK، 42501 = REVOKE، P0001 = RAISE EXCEPTION من الـ trigger.

/** ننتظر فشل العملية ونعيد معلومات خطأ pg — نجاحها هنا هو الفشل الحقيقي. */
async function expectPgFailure(operation: Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await operation;
  } catch (error) {
    return pgError(error);
  }
  throw new Error("expected the operation to be rejected by the database, but it succeeded");
}

describe.skipIf(!hasDb)("§15 — قيود القاعدة المالية والتدقيقية (تكامل)", () => {
  let h: TestHarness;
  let tenantId: string;
  let customerId: string;
  let driverId: string;

  beforeAll(async () => {
    h = connectHarness();
    await resetDb(h);
    const world = await seedWorld(h.app.db);
    tenantId = world.tenantId;
    customerId = world.customerId;
    driverId = await seedDriver(h.app.db, tenantId);
  });

  afterAll(async () => {
    await closeHarness(h);
  });

  it("قيد دفتر بإشارة خاطئة يُرفض بـ CHECK (23514) — المنظور المُلزم §8.1 مفروض تقنياً", async () => {
    // cod_collected يجب أن يكون موجباً (بذمة السائق للمكتب)
    const negativeCod = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.insert(ledgerEntries).values({ tenantId, driverId, entryType: "cod_collected", amount: -100n }),
      ),
    );
    expect(negativeCod.code).toBe("23514");
    expect(negativeCod.constraint).toBe("ledger_entries_sign_ck");

    // delivery_fee_earned يجب أن يكون سالباً (المكتب مدين للسائق بحصته)
    const positiveFee = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.insert(ledgerEntries).values({ tenantId, driverId, entryType: "delivery_fee_earned", amount: 100n }),
      ),
    );
    expect(positiveFee.code).toBe("23514");
    expect(positiveFee.constraint).toBe("ledger_entries_sign_ck");

    // adjustment الصفري عبث بلا معنى محاسبي — مرفوض أيضاً
    const zeroAdjustment = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.insert(ledgerEntries).values({ tenantId, driverId, entryType: "adjustment", amount: 0n }),
      ),
    );
    expect(zeroAdjustment.code).toBe("23514");
    expect(zeroAdjustment.constraint).toBe("ledger_entries_sign_ck");
  });

  it("order_events محصّن ضد UPDATE/DELETE بطبقتين: REVOKE على app_user وtrigger على المالك", async () => {
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, confirm: false });
    const events = await fetchOrderEvents(h.app.db, tenantId, order.id);
    const event = events[0]!;

    // الطبقة الأولى: app_user بلا صلاحية UPDATE أصلاً (REVOKE بترحيل 0003) → 42501
    const appUpdate = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.update(orderEvents).set({ toStatus: "confirmed" }).where(eq(orderEvents.id, event.id)),
      ),
    );
    expect(appUpdate.code).toBe("42501");

    const appDelete = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) => tx.delete(orderEvents).where(eq(orderEvents.id, event.id))),
    );
    expect(appDelete.code).toBe("42501");

    // الطبقة الثانية (الفخ 14 — «تصحيح» سجل تاريخي): حتى مالك الجداول (migrator) يصطدم
    // بالـ trigger — الحماية تقنية لا تعليمات (§16.14). FORCE RLS يسري عليه فنمرّ بـ withTenant.
    const ownerUpdate = await expectPgFailure(
      withTenant(h.migrator.db, tenantId, (tx) =>
        tx.update(orderEvents).set({ toStatus: "confirmed" }).where(eq(orderEvents.id, event.id)),
      ),
    );
    expect(ownerUpdate.code).toBe("P0001");
    expect(ownerUpdate.message).toMatch(/append-only/);
  });

  it("الدفتر: UPDATE على amount يُرفض بينما ربط settlement_id يمر — الاستثناء الوحيد §8.2", async () => {
    // سائق مستقل كي لا تُجرَف قيود اختبارات أخرى داخل تسويته
    const settleDriverId = await seedDriver(h.app.db, tenantId);
    const insertAdjustment = (amount: bigint) =>
      withTenant(h.app.db, tenantId, async (tx) => {
        const rows = await tx
          .insert(ledgerEntries)
          .values({ tenantId, driverId: settleDriverId, entryType: "adjustment", amount, memo: "qa" })
          .returning({ id: ledgerEntries.id });
        return rows[0]!.id;
      });

    const firstEntryId = await insertAdjustment(500n);

    // «تصحيح خطأ» بتعديل المبلغ (الفخ 14) — الـ trigger يرميه: التصحيح قيد عكسي جديد
    const amountUpdate = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.update(ledgerEntries).set({ amount: 501n }).where(eq(ledgerEntries.id, firstEntryId)),
      ),
    );
    expect(amountUpdate.code).toBe("P0001");
    expect(amountUpdate.message).toMatch(/only settlement_id/);

    // مسار الإنتاج نفسه يثبت أن ربط settlement_id مسموح: الإغلاق يربط القيد المفتوح
    const settlement = await closeDriverSettlement(h.app.db, tenantId, {
      driverId: settleDriverId,
      periodDate: "2026-07-11",
      received: 0n,
    });
    const linked = await withTenant(h.app.db, tenantId, (tx) =>
      tx
        .select({ settlementId: ledgerEntries.settlementId })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.id, firstEntryId)),
    );
    expect(linked[0]!.settlementId).toBe(settlement.id);

    // وUPDATE مباشر يقتصر على settlement_id يمر أيضاً (قيد أُدرج بعد الإغلاق ثم رُبط)
    const secondEntryId = await insertAdjustment(250n);
    const manualLink = await withTenant(h.app.db, tenantId, (tx) =>
      tx
        .update(ledgerEntries)
        .set({ settlementId: settlement.id })
        .where(eq(ledgerEntries.id, secondEntryId))
        .returning({ settlementId: ledgerEntries.settlementId }),
    );
    expect(manualLink).toHaveLength(1);
    expect(manualLink[0]!.settlementId).toBe(settlement.id);

    // قيد مُسوّى أشد حرمة — تعديل مبلغه مرفوض كذلك
    const settledAmountUpdate = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.update(ledgerEntries).set({ amount: 1n }).where(eq(ledgerEntries.id, firstEntryId)),
      ),
    );
    expect(settledAmountUpdate.code).toBe("P0001");

    // الحذف ممنوع نهائياً: app_user بالـ REVOKE (42501) والمالك بالـ trigger (P0001)
    const appDelete = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) => tx.delete(ledgerEntries).where(eq(ledgerEntries.id, firstEntryId))),
    );
    expect(appDelete.code).toBe("42501");
    const ownerDelete = await expectPgFailure(
      withTenant(h.migrator.db, tenantId, (tx) =>
        tx.delete(ledgerEntries).where(eq(ledgerEntries.id, firstEntryId)),
      ),
    );
    expect(ownerDelete.code).toBe("P0001");
    expect(ownerDelete.message).toMatch(/append-only/);
  });

  it("معادلة السعر §8.3-1 كـ CHECK: total لا يساوي مجموع المكوّنات → 23514", async () => {
    const badOrder = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.insert(orders).values({
          id: newId(),
          tenantId,
          publicCode: `inv-${Date.now().toString(36)}`,
          service: "food",
          status: "draft",
          customerId,
          pickupPoint: toPostgisWkt(DEFAULT_PICKUP),
          dropoffPoint: toPostgisWkt(DEFAULT_DROPOFF),
          // كل المكوّنات default 0 — إجمالي 100 يخرق المعادلة حتماً
          priceTotal: 100n,
        }),
      ),
    );
    expect(badOrder.code).toBe("23514");
    expect(badOrder.constraint).toBe("orders_price_equation_ck");

    // ومبلغ سالب (معادلة سليمة 0=0 لكن cod_amount<0) يصطدم بقيد اللاسالبية
    const negativeCod = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.insert(orders).values({
          id: newId(),
          tenantId,
          publicCode: `inv-neg-${Date.now().toString(36)}`,
          service: "food",
          status: "draft",
          customerId,
          pickupPoint: toPostgisWkt(DEFAULT_PICKUP),
          dropoffPoint: toPostgisWkt(DEFAULT_DROPOFF),
          codAmount: -1n,
        }),
      ),
    );
    expect(negativeCod.code).toBe("23514");
    expect(negativeCod.constraint).toBe("orders_amounts_nonnegative_ck");
  });

  it("audit_log بلا فاعل يُرفض (CHECK §3) — وبفاعل staff صحيح يمر", async () => {
    const orphanAudit = await expectPgFailure(
      withTenant(h.app.db, tenantId, (tx) =>
        tx.insert(auditLog).values({ tenantId, action: "qa.no_actor", entity: "order", entityId: newId() }),
      ),
    );
    expect(orphanAudit.code).toBe("23514");
    expect(orphanAudit.constraint).toBe("audit_log_actor_ck");

    // الإيجابي المقابل: نفس الصف بفاعل staff — يثبت أن الرفض أعلاه سببه الفاعل حصراً
    const staffId = await seedStaff(h.app.db, tenantId);
    const inserted = await withTenant(h.app.db, tenantId, (tx) =>
      tx
        .insert(auditLog)
        .values({ tenantId, actorStaffId: staffId, action: "qa.with_actor", entity: "order", entityId: newId() })
        .returning({ id: auditLog.id }),
    );
    expect(inserted).toHaveLength(1);
  });
});
