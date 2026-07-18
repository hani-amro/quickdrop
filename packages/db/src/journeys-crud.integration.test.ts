import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import {
  createJourney,
  createJourneySchema,
  deleteJourney,
  getJourney,
  listJourneys,
  updateJourney,
} from "./journeys-service.js";
import { journeyRuns, journeys, tenants } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// P2.5c — تكامل حي: CRUD تعريف الرحلة + **عزل المستأجر** (RLS): تاجر لا يرى/يعدّل/يحذف
// رحلة تاجر آخر. المُطلِّق محقّق (z.enum) — قيمة خارج المخرَّط تُرفض عند الحدّ لا تُخزَّن.

describe.skipIf(!hasDb)("journeys CRUD (تكامل، قاعدة حية) — عزل المستأجر", () => {
  let app: DbHandle;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const rows = await app.db
      .insert(tenants)
      .values([
        { slug: `jca-${Date.now().toString(36)}`, name: "CRUD A", nameAr: "أ" },
        { slug: `jcb-${Date.now().toString(36)}`, name: "CRUD B", nameAr: "ب" },
      ])
      .returning({ id: tenants.id });
    tenantA = rows[0]!.id;
    tenantB = rows[1]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await withTenant(app.db, t, async (tx) => {
        await tx.delete(journeyRuns).where(eq(journeyRuns.tenantId, t));
        await tx.delete(journeys).where(eq(journeys.tenantId, t));
      });
      await app.db.delete(tenants).where(eq(tenants.id, t));
    }
    await app.close();
  });

  const validInput = {
    name: "win-back",
    trigger: "crm.lifecycle_changed" as const,
    audienceFilter: { lifecycleStage: ["at_risk"] },
    steps: [{ type: "send_message" as const, delayHours: 0, template: "مرحبا {name}" }],
  };

  it("createJourneySchema يرفض مُطلِّقاً خارج JOURNEY_TRIGGERS", () => {
    expect(createJourneySchema.safeParse({ ...validInput, trigger: "order.status_changed" }).success).toBe(false);
    expect(createJourneySchema.safeParse({ ...validInput, trigger: "bogus" }).success).toBe(false);
    expect(createJourneySchema.safeParse(validInput).success).toBe(true);
  });

  it("createJourneySchema يرفض حقلاً مجهولاً (strict) وخطوات فارغة", () => {
    expect(createJourneySchema.safeParse({ ...validInput, extra: 1 }).success).toBe(false);
    expect(createJourneySchema.safeParse({ ...validInput, steps: [] }).success).toBe(false);
  });

  it("create ثم get/list يعيدان الرحلة في مستأجرها", async () => {
    const created = await withTenant(app.db, tenantA, (tx) => createJourney(tx, tenantA, validInput));
    expect(created.trigger).toBe("crm.lifecycle_changed");
    expect(created.isActive).toBe(false); // افتراضي

    const got = await withTenant(app.db, tenantA, (tx) => getJourney(tx, tenantA, created.id));
    expect(got?.id).toBe(created.id);

    const list = await withTenant(app.db, tenantA, (tx) => listJourneys(tx, tenantA));
    expect(list.map((j) => j.id)).toContain(created.id);
  });

  it("عزل: المستأجر B لا يرى ولا يجلب رحلة المستأجر A", async () => {
    const aRows = await withTenant(app.db, tenantA, (tx) => listJourneys(tx, tenantA));
    const aId = aRows[0]!.id;

    const bList = await withTenant(app.db, tenantB, (tx) => listJourneys(tx, tenantB));
    expect(bList).toHaveLength(0);

    const bGet = await withTenant(app.db, tenantB, (tx) => getJourney(tx, tenantB, aId));
    expect(bGet).toBeNull(); // RLS يمنع حتى بمعرّف صحيح
  });

  it("عزل: تحديث/حذف المستأجر B لا يطال رحلة المستأجر A", async () => {
    const aId = (await withTenant(app.db, tenantA, (tx) => listJourneys(tx, tenantA)))[0]!.id;

    const bUpdate = await withTenant(app.db, tenantB, (tx) => updateJourney(tx, tenantB, aId, { isActive: true }));
    expect(bUpdate).toBeNull(); // لا صف في نطاق B

    const bDelete = await withTenant(app.db, tenantB, (tx) => deleteJourney(tx, tenantB, aId));
    expect(bDelete).toBe(false);

    // رحلة A سليمة (لم تتفعّل ولم تُحذف)
    const aStill = await withTenant(app.db, tenantA, (tx) => getJourney(tx, tenantA, aId));
    expect(aStill?.isActive).toBe(false);
  });

  it("update يعدّل جزئياً؛ المُطلِّق غير قابل للتغيير (ليس بالسكيما)", async () => {
    const aId = (await withTenant(app.db, tenantA, (tx) => listJourneys(tx, tenantA)))[0]!.id;
    const updated = await withTenant(app.db, tenantA, (tx) => updateJourney(tx, tenantA, aId, { name: "win-back v2", isActive: true }));
    expect(updated?.name).toBe("win-back v2");
    expect(updated?.isActive).toBe(true);
    expect(updated?.trigger).toBe("crm.lifecycle_changed"); // ثابت
  });

  it("delete يحذف الرحلة (وصفوف runs معها) ويعيد false لغير الموجود", async () => {
    const aId = (await withTenant(app.db, tenantA, (tx) => listJourneys(tx, tenantA)))[0]!.id;
    const deleted = await withTenant(app.db, tenantA, (tx) => deleteJourney(tx, tenantA, aId));
    expect(deleted).toBe(true);
    const gone = await withTenant(app.db, tenantA, (tx) => getJourney(tx, tenantA, aId));
    expect(gone).toBeNull();
    const again = await withTenant(app.db, tenantA, (tx) => deleteJourney(tx, tenantA, aId));
    expect(again).toBe(false);
  });
});
