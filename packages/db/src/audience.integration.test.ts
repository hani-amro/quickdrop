import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countAudience } from "./audience.js";
import { BroadcastNotFoundError, createBroadcast, enqueueBroadcast } from "./broadcasts.js";
import { createDb, type DbHandle } from "./client.js";
import { broadcasts, customerProfiles, tenants, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// P2.6 — تكامل حي: ترشيح جمهور الحملة (Campaigns على نمط البث) + **عزل المستأجر**.
// enqueueBroadcast يطبّق audience_filter المخزّن؛ countAudience يعاين الوصول. الزبون بلا
// ملف/محظور/بلا تيليغرام لا يدخل الجمهور. تاجر لا يبثّ لزبائن تاجر آخر (RLS).

describe.skipIf(!hasDb)("audience/campaigns (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantA: string;
  let tenantB: string;
  const uid: Record<string, string> = {};

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db
      .insert(tenants)
      .values([
        { slug: `auda-${Date.now().toString(36)}`, name: "Aud A", nameAr: "أ" },
        { slug: `audb-${Date.now().toString(36)}`, name: "Aud B", nameAr: "ب" },
      ])
      .returning({ id: tenants.id });
    tenantA = t[0]!.id;
    tenantB = t[1]!.id;

    await withTenant(app.db, tenantA, async (tx) => {
      // c1: at_risk، rfm 20، وسم vip، تيليغرام
      // c2: active، rfm 80، بلا وسوم، تيليغرام
      // c3: تيليغرام بلا ملف (لم يحسبه الدماغ) — يطابق "الكل" فقط
      // c4: محظور (blocked_at) — يُقصى دوماً
      // c5: بلا تيليغرام (زبون تلفون) — يُقصى دوماً
      const rows = await tx
        .insert(users)
        .values([
          { tenantId: tenantA, role: "customer", telegramUserId: 1001, firstName: "c1" },
          { tenantId: tenantA, role: "customer", telegramUserId: 1002, firstName: "c2" },
          { tenantId: tenantA, role: "customer", telegramUserId: 1003, firstName: "c3" },
          { tenantId: tenantA, role: "customer", telegramUserId: 1004, firstName: "c4", blockedAt: new Date() },
          { tenantId: tenantA, role: "customer", phoneE164: "+963900000005", firstName: "c5" },
        ])
        .returning({ id: users.id, tg: users.telegramUserId, phone: users.phoneE164 });
      for (const r of rows) {
        const key = r.tg === 1001 ? "c1" : r.tg === 1002 ? "c2" : r.tg === 1003 ? "c3" : r.tg === 1004 ? "c4" : "c5";
        uid[key] = r.id;
      }
      await tx.insert(customerProfiles).values([
        { tenantId: tenantA, userId: uid["c1"]!, lifecycleStage: "at_risk", rfmScore: 20, tags: ["vip"] },
        { tenantId: tenantA, userId: uid["c2"]!, lifecycleStage: "active", rfmScore: 80, tags: [] },
        { tenantId: tenantA, userId: uid["c4"]!, lifecycleStage: "at_risk", rfmScore: 20, tags: ["vip"] }, // لكنه محظور
      ]);
    });

    // مستأجر B: زبون تيليغرام مطابق لكل الفلاتر — يجب ألا يظهر أبداً في جمهور A
    await withTenant(app.db, tenantB, async (tx) => {
      const r = await tx.insert(users).values({ tenantId: tenantB, role: "customer", telegramUserId: 2001, firstName: "b1" }).returning({ id: users.id });
      await tx.insert(customerProfiles).values({ tenantId: tenantB, userId: r[0]!.id, lifecycleStage: "at_risk", rfmScore: 20, tags: ["vip"] });
    });
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await withTenant(app.db, t, async (tx) => {
        await tx.delete(broadcasts).where(eq(broadcasts.tenantId, t));
        await tx.delete(customerProfiles).where(eq(customerProfiles.tenantId, t));
        await tx.delete(users).where(eq(users.tenantId, t));
      });
      await app.db.delete(tenants).where(eq(tenants.id, t));
    }
    await app.close();
  });

  /** ينشئ بثّة بفلتر ثم يبدؤها ويعيد معرّفات المستخدمين في الجمهور الناتج (مرتّبة). */
  async function audienceOf(filter: Record<string, unknown> | undefined): Promise<Set<string>> {
    const b = await createBroadcast(app.db, tenantA, { body: "حملة", ...(filter ? { audienceFilter: filter } : {}) });
    const { audience } = await enqueueBroadcast(app.db, tenantA, b.id);
    return new Set(audience.map((m) => m.userId));
  }

  it("بلا فلتر → كل الزبائن الواصلين (تيليغرام، غير محظورين)؛ يُقصى المحظور وبلا-تيليغرام", async () => {
    const got = await audienceOf(undefined);
    expect(got).toEqual(new Set([uid["c1"], uid["c2"], uid["c3"]]));
    expect(got.has(uid["c4"]!)).toBe(false); // محظور
    expect(got.has(uid["c5"]!)).toBe(false); // بلا تيليغرام
  });

  it("lifecycleStage=[at_risk] → c1 فقط (c4 at_risk لكنه محظور)", async () => {
    expect(await audienceOf({ lifecycleStage: ["at_risk"] })).toEqual(new Set([uid["c1"]]));
  });

  it("minRfm=75 → c2 فقط", async () => {
    expect(await audienceOf({ minRfm: 75 })).toEqual(new Set([uid["c2"]]));
  });

  it("tags=[vip] → c1 فقط (c3 بلا ملف لا يطابق فلتراً ملفّياً)", async () => {
    expect(await audienceOf({ tags: ["vip"] })).toEqual(new Set([uid["c1"]]));
  });

  it("فلتر مركّب at_risk + minRfm 50 → لا أحد (c1 rfm=20 < 50)", async () => {
    expect(await audienceOf({ lifecycleStage: ["at_risk"], minRfm: 50 })).toEqual(new Set());
  });

  it("countAudience يطابق حجم الجمهور الفعلي", async () => {
    expect(await countAudience(app.db, tenantA, null)).toBe(3);
    expect(await countAudience(app.db, tenantA, { lifecycleStage: ["at_risk"] })).toBe(1);
    expect(await countAudience(app.db, tenantA, { minRfm: 75 })).toBe(1);
    expect(await countAudience(app.db, tenantA, { lifecycleStage: ["at_risk"], minRfm: 50 })).toBe(0);
  });

  it("عزل: جمهور A لا يضمّ زبون B رغم مطابقته كل الفلاتر", async () => {
    const all = await audienceOf(undefined);
    const vip = await audienceOf({ tags: ["vip"] });
    for (const s of [all, vip]) {
      for (const id of s) expect(id).not.toBe(uid["b1"]);
    }
    // B لا يرى بثّة أنشأها A (RLS) — enqueue بمعرّف A من نطاق B يرمي NotFound
    const bcast = await createBroadcast(app.db, tenantA, { body: "x" });
    await expect(enqueueBroadcast(app.db, tenantB, bcast.id)).rejects.toBeInstanceOf(BroadcastNotFoundError);
  });

  it("فلتر مخزّن فاسد → enqueueBroadcast يرمي (DLQ لا بثّ أعمى)", async () => {
    const b = await createBroadcast(app.db, tenantA, { body: "bad" });
    // حقن فساد مباشر (الـ API يتحقّق §11؛ هذا يحاكي فساد بيانات)
    await withTenant(app.db, tenantA, (tx) =>
      tx.update(broadcasts).set({ audienceFilter: { minRfm: 500 } as unknown as Record<string, never> }).where(eq(broadcasts.id, b.id)),
    );
    await expect(enqueueBroadcast(app.db, tenantA, b.id)).rejects.toThrow(/malformed/);
    // لم تُقلب الحالة إلى sending (الرمي قبل التحديث)
    const st = await withTenant(app.db, tenantA, async (tx) => {
      const r = await tx.select({ status: broadcasts.status }).from(broadcasts).where(eq(broadcasts.id, b.id));
      return r[0]!.status;
    });
    expect(st).toBe("draft");
    // نظافة العدّاد المخزّن الفاسد كي لا يُفسد التفكيك
    await withTenant(app.db, tenantA, (tx) => tx.update(broadcasts).set({ audienceFilter: sql`NULL` }).where(eq(broadcasts.id, b.id)));
  });
});
