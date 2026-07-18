import { createDb, customerProfiles, outbox, tenants, users, waWebhookUpdates, withTenant, type DbHandle } from "@quickdrop/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processWaUpdate } from "./wa-update-processor.js";

// MERGE_PLAN §3.1/§4.3 — تكامل حي لمستهلك واتساب: صف inbox → دمج هوية الزبون
// (قواعد §4.3 الثلاث + adversary #10: لا استيلاء على wa_id قائم) → حدثا spine بنفس
// الترانزاكشن → processed بتحديث شرطي (إعادة التسليم duplicate بلا آثار مكررة).

const APP_URL = process.env["DATABASE_URL"];
const hasDb = Boolean(APP_URL);

const WA_ID = "60111222333";

function inboxValue(waId: string, wamid: string, name?: string): Record<string, unknown> {
  return {
    metadata: { phone_number_id: "PNID-int" },
    ...(name !== undefined ? { contacts: [{ wa_id: waId, profile: { name } }] } : {}),
    messages: [{ id: wamid, from: waId, type: "text" }],
  };
}

describe.skipIf(!hasDb)("wa-update-processor (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantId: string;

  async function seedInboxRow(eventKey: string, payload: Record<string, unknown>): Promise<string> {
    return withTenant(app.db, tenantId, async (tx) => {
      const r = await tx
        .insert(waWebhookUpdates)
        .values({ tenantId, eventKey, payload })
        .returning({ id: waWebhookUpdates.id });
      return r[0]!.id;
    });
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db
      .insert(tenants)
      .values({ slug: `wa-proc-${Date.now().toString(36)}`, name: "WA Proc QA", nameAr: "معالج" })
      .returning({ id: tenants.id });
    tenantId = t[0]!.id;
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.delete(outbox).where(eq(outbox.tenantId, tenantId));
      await tx.delete(waWebhookUpdates).where(eq(waWebhookUpdates.tenantId, tenantId));
      await tx.delete(customerProfiles).where(eq(customerProfiles.tenantId, tenantId));
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  it("زبون جديد: user + customer_profiles + حدثا contact.created وwa.message.received + processed", async () => {
    const rowId = await seedInboxRow("wamid.new1", inboxValue(WA_ID, "wamid.new1", "Aisha"));
    const outcome = await processWaUpdate({ appDb: app.db }, { tenantId, updateId: rowId });
    expect(outcome).toBe("processed");

    const result = await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.waId, WA_ID)));
      const p = u[0] ? await tx.select().from(customerProfiles).where(eq(customerProfiles.userId, u[0].id)) : [];
      const events = await tx.select({ topic: outbox.topic }).from(outbox).where(eq(outbox.tenantId, tenantId));
      const inboxRow = await tx.select({ status: waWebhookUpdates.status }).from(waWebhookUpdates).where(eq(waWebhookUpdates.id, rowId));
      return { user: u[0], profile: p[0], topics: events.map((e) => e.topic).sort(), inboxStatus: inboxRow[0]!.status };
    });

    expect(result.user).toBeDefined();
    expect(result.user!.role).toBe("customer");
    expect(result.user!.phoneE164).toBe(`+${WA_ID}`);
    expect(result.user!.firstName).toBe("Aisha");
    expect(result.profile).toBeDefined(); // ملف CRM أُنشئ 1:1 (D-M2)
    expect(result.topics).toEqual(["contact.created", "wa.message.received"]);
    expect(result.inboxStatus).toBe("processed");
  });

  it("إعادة تسليم نفس الصف = duplicate بلا أحداث ولا مستخدمين إضافيين (idempotent)", async () => {
    const rowId = await withTenant(app.db, tenantId, async (tx) => {
      const r = await tx.select({ id: waWebhookUpdates.id }).from(waWebhookUpdates).where(eq(waWebhookUpdates.eventKey, "wamid.new1"));
      return r[0]!.id;
    });
    const outcome = await processWaUpdate({ appDb: app.db }, { tenantId, updateId: rowId });
    expect(outcome).toBe("duplicate");
    const counts = await withTenant(app.db, tenantId, async (tx) => {
      const events = await tx.select().from(outbox).where(eq(outbox.tenantId, tenantId));
      const us = await tx.select().from(users).where(eq(users.tenantId, tenantId));
      return { events: events.length, users: us.length };
    });
    expect(counts).toEqual({ events: 2, users: 1 });
  });

  it("زبون تلفون قائم بنفس الرقم وبلا wa_id: يُربط (لا صف جديد)؛ ورسالة تالية لنفس wa_id لا تنشئ contact.created", async () => {
    const phone = "+60119998877";
    const phoneCustomerId = await withTenant(app.db, tenantId, async (tx) => {
      const r = await tx
        .insert(users)
        .values({ tenantId, role: "customer", phoneE164: phone, firstName: "زبون تلفون" })
        .returning({ id: users.id });
      return r[0]!.id;
    });

    const rowId = await seedInboxRow("wamid.attach1", inboxValue("60119998877", "wamid.attach1"));
    await processWaUpdate({ appDb: app.db }, { tenantId, updateId: rowId });

    const check = await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.select({ id: users.id, waId: users.waId }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.phoneE164, phone)));
      const created = await tx
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "contact.created")));
      return { user: u[0], contactCreatedCount: created.length };
    });
    expect(check.user!.id).toBe(phoneCustomerId); // رُبط — لا صف جديد
    expect(check.user!.waId).toBe("60119998877");
    expect(check.contactCreatedCount).toBe(1); // فقط حدث الزبون الأول من الاختبار السابق
  });
});
