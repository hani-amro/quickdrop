import { createDb, drivers, tenants, users, withTenant, type DbHandle } from "@quickdrop/db";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { DriverService } from "./driver.service.js";

// P5.1 — قناة السائق (PWA): مصادقة قابلة للإبطال + منتهية + معزولة. تكامل حي (DB + Redis).
// نُثبت: إصدار رابط → مبادلة → جلسة تُحلّ للسائق الصحيح؛ إبطال المكتب → الجلسة تفشل فوراً؛
// إعادة الإصدار بعد الإبطال تنجح؛ إعادة المصادقة تدوّر (جلسة واحدة)؛ العزل: الجلسة تحمل
// مستأجرها فكل الأفعال ضمنه (لا اختيار مستأجر من العميل).

const APP_URL = process.env["DATABASE_URL"];
const REDIS_URL = process.env["REDIS_URL"];
const hasDeps = Boolean(APP_URL && REDIS_URL);

const STAFF_TOKEN = "s".repeat(40);
const env = { STAFF_API_TOKEN: STAFF_TOKEN } as unknown as ApiEnv;
const staffAuth = `Bearer ${STAFF_TOKEN}`;

describe.skipIf(!hasDeps)("DriverService — مصادقة قابلة للإبطال + عزل (P5.1)", () => {
  let handle: DbHandle;
  let redis: Redis;
  let service: DriverService;
  let tenantId: string;
  let slug: string;
  let driverId: string;

  beforeAll(async () => {
    handle = createDb(APP_URL!);
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    service = new DriverService(handle, env, redis);
    slug = `drv-${Date.now().toString(36)}`;
    const t = await handle.db.insert(tenants).values({ slug, name: "Driver QA", nameAr: "سائق" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    driverId = await withTenant(handle.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "driver", firstName: "Aziz", phoneE164: "+60123000111" }).returning({ id: users.id });
      const d = await tx.insert(drivers).values({ tenantId, userId: u[0]!.id, vehicle: "motorbike", status: "offline" }).returning({ id: drivers.id });
      return d[0]!.id;
    });
  });

  afterAll(async () => {
    await withTenant(handle.db, tenantId, async (tx) => {
      await tx.delete(drivers).where(eq(drivers.tenantId, tenantId));
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
    redis.disconnect();
  });

  async function issueAndAuth(): Promise<string> {
    const link = await service.issueLink(staffAuth, driverId, { tenantSlug: slug });
    const auth = await service.auth({ tenantSlug: slug, code: link.code });
    return auth.token;
  }

  it("إصدار → مبادلة → me يُحلّ للسائق الصحيح", async () => {
    const link = await service.issueLink(staffAuth, driverId, { tenantSlug: slug });
    expect(link.code).toMatch(/^[0-9a-f]{16}$/);
    expect(link.deepLink).toContain(`code=${link.code}`);
    expect(link.deepLink).toContain(`tenant=${slug}`);

    const auth = await service.auth({ tenantSlug: slug, code: link.code });
    expect(auth.token).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.driver.id).toBe(driverId);
    expect(auth.driver.name).toBe("Aziz");

    const me = await service.me(`Bearer ${auth.token}`);
    expect(me.driver.id).toBe(driverId);
  });

  it("الكود لمرة واحدة: إعادة استخدامه → 401", async () => {
    const link = await service.issueLink(staffAuth, driverId, { tenantSlug: slug });
    await service.auth({ tenantSlug: slug, code: link.code }); // أول استخدام
    await expect(service.auth({ tenantSlug: slug, code: link.code })).rejects.toMatchObject({ status: 401 });
  });

  it("كود مجهول / توكن مجهول → 401", async () => {
    await expect(service.auth({ tenantSlug: slug, code: "ffffffffffffffff" })).rejects.toMatchObject({ status: 401 });
    await expect(service.me("Bearer " + "0".repeat(32))).rejects.toMatchObject({ status: 401 });
    await expect(service.me(undefined)).rejects.toMatchObject({ status: 401 });
  });

  it("إبطال المكتب → الجلسة النشطة تفشل فوراً؛ وإعادة الإصدار بعده تنجح", async () => {
    const token = await issueAndAuth();
    expect((await service.me(`Bearer ${token}`)).driver.id).toBe(driverId); // نشطة

    await service.revokeAccess(staffAuth, driverId, { tenantSlug: slug });
    await expect(service.me(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 }); // أُبطلت فوراً

    const fresh = await issueAndAuth(); // المكتب يعيد الإصدار
    expect((await service.me(`Bearer ${fresh}`)).driver.id).toBe(driverId);
  });

  it("جلسة واحدة نشطة: إعادة المصادقة تدوّر (التوكن القديم يُبطَل)", async () => {
    const first = await issueAndAuth();
    expect((await service.me(`Bearer ${first}`)).driver.id).toBe(driverId);
    const second = await issueAndAuth(); // مصادقة ثانية
    await expect(service.me(`Bearer ${first}`)).rejects.toMatchObject({ status: 401 }); // القديم أُبطل
    expect((await service.me(`Bearer ${second}`)).driver.id).toBe(driverId);
  });

  it("الوردية عبر الجلسة: start → online (الفعل ضمن مستأجر الجلسة حصراً)", async () => {
    const token = await issueAndAuth();
    const r = await service.shift(`Bearer ${token}`, { action: "start" });
    expect(r.status).toBe("online");
    const back = await service.shift(`Bearer ${token}`, { action: "end" });
    expect(back.status).toBe("offline");
  });
});
