import { randomBytes } from "node:crypto";
import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  acceptOffer,
  driverTransition,
  drivers,
  findDriverActiveOrderForPod,
  insertPodAttachment,
  listDriverAssignedOrders,
  listDriverOffers,
  recordDriverLocationTx,
  rejectOffer,
  setDriverShift,
  tenants,
  users,
  withTenant,
  type AcceptResult,
  type DbHandle,
  type DriverOfferView,
  type DriverOrderView,
} from "@quickdrop/db";
import { publishRt, RT_EVENTS } from "@quickdrop/shared";
import {
  createStorageClient,
  ImageValidationError,
  podKey,
  tryLoadStorageConfig,
  validateAndReencode,
  type StorageClient,
} from "@quickdrop/storage";
import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import { DB, ENV, REDIS } from "../tokens.js";
import type { ApiEnv } from "../env.js";

const officeTenantSchema = z.object({ tenantSlug: slugSchema });

// P5.1 — قناة السائق (PWA خفيف بديل بوت تيليغرام لماليزيا: موقع حيّ مستمر بلا تثبيت تطبيق).
// المصادقة تستنسخ نمطي الـ miniapp (جلسة Redis مجهولة قابلة للإبطال، لا JWT) وربط التاجر
// (deep-link كود لمرة واحدة). كل مسارات البيانات محروسة بتوكن Bearer، والمستأجر/السائق
// منه حصراً (لا اختيار مستأجر من العميل — نفس عزل الـ miniapp).
//
// قابل للإبطال + منتهٍ (توجيه المالك): جلسة واحدة نشطة لكل سائق (driver:cur) — إعادة الإصدار
// تدوّر، والمكتب يُبطل فوراً (revokeAccess يحذف الجلسة + الرابط المعلّق). TTL = وردية.

const LINK_PREFIX = "dlink:"; // dlink:{tenantId}:{code} → driverId (كود ربط لمرة واحدة)
const LINK_BY_DRIVER_PREFIX = "dlinkcur:"; // dlinkcur:{tenantId}:{driverId} → code (للإبطال)
const SESSION_PREFIX = "driversess:"; // driversess:{token} → {tenantId, driverId, userId}
const SESSION_BY_DRIVER_PREFIX = "drivercur:"; // drivercur:{tenantId}:{driverId} → token (جلسة واحدة/إبطال)
const LINK_TTL_S = 900; // 15 دقيقة — نافذة استخدام الرابط
const SESSION_TTL_S = 43200; // 12 ساعة — طول وردية؛ ينتهي فيُعاد الإصدار

const authBodySchema = z.object({ tenantSlug: slugSchema, code: z.string().regex(/^[0-9a-f]{16}$/) });
const shiftBodySchema = z.object({ action: z.enum(["start", "end", "toggle"]) });
// السائق ينقل حالات محددة فقط؛ assigned يأتي عبر قبول العرض لا هنا (transition يفرض الفاعل أيضاً).
const statusBodySchema = z.object({ to: z.enum(["picked_up", "in_transit", "arrived", "delivered", "failed"]) });
const locationBodySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  // ISO اختياري — نتسامح مع غيابه (الآن)؛ نرفض المستقبل البعيد/الماضي السحيق ضمنياً بالنوع
  recordedAt: z.string().datetime().optional(),
});
const podBodySchema = z.object({
  // صورة base64 (بلا بادئة data:)؛ حد ~8MB نصاً ≈ 6MB ثنائي (validateAndReencode يحدّ 10MB أيضاً)
  imageBase64: z.string().min(1).max(8_000_000),
});

const driverSessionSchema = z.object({ tenantId: z.string().uuid(), driverId: z.string().uuid(), userId: z.string().uuid() });
type DriverSession = z.infer<typeof driverSessionSchema>;

export interface DriverLinkResponse {
  code: string;
  deepLink: string;
  expiresInSeconds: number;
}
export interface DriverAuthResponse {
  token: string;
  expiresInSeconds: number;
  driver: { id: string; name: string | null; status: string };
}
export interface DriverMeResponse {
  driver: { id: string; name: string | null; status: string };
}

@Injectable()
export class DriverService {
  private readonly storage: StorageClient | null;

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    const cfg = tryLoadStorageConfig(process.env);
    this.storage = cfg !== null ? createStorageClient(cfg) : null;
  }

  private linkKey(tenantId: string, code: string): string {
    return `${LINK_PREFIX}${tenantId}:${code}`;
  }
  private sessionKey(token: string): string {
    return `${SESSION_PREFIX}${token}`;
  }

  /** GET+DEL ذرّي (كود لمرة واحدة) عبر MULTI — يعمل على Redis أقدم من 6.2 (بلا GETDEL). */
  private async getdel(key: string): Promise<string | null> {
    const res = await this.redis.multi().get(key).del(key).exec();
    const first = res?.[0];
    if (!first || first[0] !== null) return null; // خطأ في الأمر الأول
    return (first[1] as string | null) ?? null;
  }

  // —— المكتب (محروس بجلسة الطاقم عبر DriversController) ——

  /** §3 (P5.1) — يصدر كود ربط لمرة واحدة لسائق ورابط PWA يفتحه. محروس بجلسة الطاقم. */
  async issueLink(authorization: string | undefined, rawDriverId: string, body: unknown): Promise<DriverLinkResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(officeTenantSchema, body, "driver_link");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const tenantId = tenant.id;
    const driverId = parseOr400(uuidSchema, rawDriverId, "driver_link_id");
    const exists = await withTenant(this.handle.db, tenantId, (tx) =>
      tx.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.tenantId, tenantId), eq(drivers.id, driverId))).limit(1),
    );
    if (!exists[0]) throw new HttpException("driver not found", HttpStatus.NOT_FOUND);

    const code = randomBytes(8).toString("hex"); // 16 hex
    await this.redis.set(this.linkKey(tenantId, code), driverId, "EX", LINK_TTL_S);
    await this.redis.set(`${LINK_BY_DRIVER_PREFIX}${tenantId}:${driverId}`, code, "EX", LINK_TTL_S);
    const base = (this.env.DRIVER_APP_URL ?? "http://localhost:5174").replace(/\/+$/, "");
    const deepLink = `${base}/?tenant=${encodeURIComponent(input.tenantSlug)}&code=${code}`;
    console.log(JSON.stringify({ action: "driver_link_issued", tenant_id: tenantId, driver_id: driverId }));
    return { code, deepLink, expiresInSeconds: LINK_TTL_S };
  }

  /** §3 (P5.1) — إبطال وصول سائق فوراً: حذف الجلسة النشطة + الرابط المعلّق (سائق غادر المطعم). */
  async revokeAccess(authorization: string | undefined, rawDriverId: string, body: unknown): Promise<{ revoked: true }> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(officeTenantSchema, body, "driver_revoke");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const tenantId = tenant.id;
    const driverId = parseOr400(uuidSchema, rawDriverId, "driver_revoke_id");
    const curToken = await this.redis.get(`${SESSION_BY_DRIVER_PREFIX}${tenantId}:${driverId}`);
    if (curToken !== null) await this.redis.del(this.sessionKey(curToken));
    await this.redis.del(`${SESSION_BY_DRIVER_PREFIX}${tenantId}:${driverId}`);
    const pendingCode = await this.redis.get(`${LINK_BY_DRIVER_PREFIX}${tenantId}:${driverId}`);
    if (pendingCode !== null) await this.redis.del(this.linkKey(tenantId, pendingCode));
    await this.redis.del(`${LINK_BY_DRIVER_PREFIX}${tenantId}:${driverId}`);
    console.log(JSON.stringify({ action: "driver_access_revoked", tenant_id: tenantId, driver_id: driverId }));
    return { revoked: true };
  }

  // —— السائق (self-guarding: /api/driver معفى من SessionGuard) ——

  /** تبادل كود الربط بتوكن جلسة (يدوّر أي جلسة سابقة — جلسة واحدة نشطة). كل الأخطاء 401 عامة. */
  async auth(body: unknown): Promise<DriverAuthResponse> {
    const input = parseOr400(authBodySchema, body, "driver_auth");
    const tenantRows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.slug, input.tenantSlug))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") throw new UnauthorizedException();

    // GET+DEL ذرّي: الكود لمرة واحدة (لا يُعاد استخدامه) ومحدّد بمستأجره (المفتاح namespaced)
    const driverId = await this.getdel(this.linkKey(tenant.id, input.code));
    if (driverId === null) throw new UnauthorizedException();

    const rows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({ driverId: drivers.id, status: drivers.status, userId: users.id, firstName: users.firstName })
        .from(drivers)
        .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
        .where(and(eq(drivers.tenantId, tenant.id), eq(drivers.id, driverId)))
        .limit(1),
    );
    const driver = rows[0];
    if (!driver) throw new UnauthorizedException();

    // تدوير: أبطل الجلسة السابقة إن وُجدت (جلسة واحدة نشطة لكل سائق)
    const prev = await this.redis.get(`${SESSION_BY_DRIVER_PREFIX}${tenant.id}:${driver.driverId}`);
    if (prev !== null) await this.redis.del(this.sessionKey(prev));

    const token = randomBytes(16).toString("hex"); // 128-bit مجهول
    const session: DriverSession = { tenantId: tenant.id, driverId: driver.driverId, userId: driver.userId };
    await this.redis.set(this.sessionKey(token), JSON.stringify(session), "EX", SESSION_TTL_S);
    await this.redis.set(`${SESSION_BY_DRIVER_PREFIX}${tenant.id}:${driver.driverId}`, token, "EX", SESSION_TTL_S);
    console.log(JSON.stringify({ action: "driver_auth", outcome: "ok", tenant_id: tenant.id, driver_id: driver.driverId }));
    return { token, expiresInSeconds: SESSION_TTL_S, driver: { id: driver.driverId, name: driver.firstName, status: driver.status } };
  }

  private async resolveSession(authorization: string | undefined): Promise<DriverSession> {
    const bearer = authorization?.match(/^Bearer\s+([0-9a-f]{32})$/)?.[1];
    if (bearer === undefined) throw new UnauthorizedException();
    const raw = await this.redis.get(this.sessionKey(bearer));
    if (raw === null) throw new UnauthorizedException(); // منتهٍ/مُبطَل/مجهول
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UnauthorizedException();
    }
    const parsed = driverSessionSchema.safeParse(json);
    if (!parsed.success) throw new UnauthorizedException();
    return parsed.data;
  }

  async me(authorization: string | undefined): Promise<DriverMeResponse> {
    const s = await this.resolveSession(authorization);
    const rows = await withTenant(this.handle.db, s.tenantId, (tx) =>
      tx
        .select({ id: drivers.id, status: drivers.status, firstName: users.firstName })
        .from(drivers)
        .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
        .where(and(eq(drivers.tenantId, s.tenantId), eq(drivers.id, s.driverId)))
        .limit(1),
    );
    const d = rows[0];
    if (!d) throw new UnauthorizedException();
    return { driver: { id: d.id, name: d.firstName, status: d.status } };
  }

  async shift(authorization: string | undefined, body: unknown): Promise<{ status: string }> {
    const s = await this.resolveSession(authorization);
    const input = parseOr400(shiftBodySchema, body, "driver_shift");
    const status = await setDriverShift(this.handle.db, s.tenantId, s.driverId, input.action);
    return { status };
  }

  async orders(authorization: string | undefined): Promise<{ orders: DriverOrderView[] }> {
    const s = await this.resolveSession(authorization);
    return { orders: await listDriverAssignedOrders(this.handle.db, s.tenantId, s.driverId) };
  }

  async offers(authorization: string | undefined): Promise<{ offers: DriverOfferView[] }> {
    const s = await this.resolveSession(authorization);
    return { offers: await listDriverOffers(this.handle.db, s.tenantId, s.driverId) };
  }

  async acceptOffer(authorization: string | undefined, rawOfferId: string): Promise<AcceptResult> {
    const s = await this.resolveSession(authorization);
    const offerId = parseOr400(uuidSchema, rawOfferId, "driver_accept_id");
    // acceptOffer يفرض داخلياً أن العرض لهذا السائق (driver_id) وضمن المستأجر — لا انتحال
    return acceptOffer(this.handle.db, s.tenantId, offerId, s.driverId);
  }

  async rejectOffer(authorization: string | undefined, rawOfferId: string): Promise<{ ok: true }> {
    const s = await this.resolveSession(authorization);
    const offerId = parseOr400(uuidSchema, rawOfferId, "driver_reject_id");
    await rejectOffer(this.handle.db, s.tenantId, offerId, s.driverId);
    return { ok: true };
  }

  async status(authorization: string | undefined, rawOrderId: string, body: unknown): Promise<{ ok: boolean; status?: string; reason?: string }> {
    const s = await this.resolveSession(authorization);
    const orderId = parseOr400(uuidSchema, rawOrderId, "driver_status_id");
    const input = parseOr400(statusBodySchema, body, "driver_status");
    const result = await driverTransition(this.handle.db, s.tenantId, s.driverId, orderId, input.to);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, status: result.order.status };
  }

  async location(authorization: string | undefined, body: unknown): Promise<{ ok: true; suspect: boolean }> {
    const s = await this.resolveSession(authorization);
    const input = parseOr400(locationBodySchema, body, "driver_location");
    const recordedAt = input.recordedAt !== undefined ? new Date(input.recordedAt) : new Date();
    const { isSuspect } = await recordDriverLocationTx(this.handle.db, s.tenantId, s.driverId, { lat: input.lat, lng: input.lng }, recordedAt);
    if (!isSuspect) {
      // §10.1 — نقطة غير مشبوهة → حدث driver.location لغرفة المستأجر (أفضل جهد؛ publishRt لا يرمي)
      await publishRt(this.redis, {
        tenantId: s.tenantId,
        event: RT_EVENTS.driverLocation,
        payload: { driverId: s.driverId, lat: input.lat, lng: input.lng, recordedAt: recordedAt.toISOString() },
      });
    }
    return { ok: true, suspect: isSuspect };
  }

  async pod(authorization: string | undefined, body: unknown): Promise<{ outcome: string; publicCode?: string; reason?: string }> {
    const s = await this.resolveSession(authorization);
    if (this.storage === null) throw new HttpException("storage not configured", HttpStatus.SERVICE_UNAVAILABLE);
    const input = parseOr400(podBodySchema, body, "driver_pod");

    const order = await findDriverActiveOrderForPod(this.handle.db, s.tenantId, s.driverId);
    if (!order) return { outcome: "no_active_order" };

    let reencoded;
    try {
      reencoded = await validateAndReencode(Buffer.from(input.imageBase64, "base64"));
    } catch (error) {
      if (error instanceof ImageValidationError) return { outcome: "rejected", reason: error.reason };
      throw error; // §16.12
    }
    const key = podKey(s.tenantId, order.id, "jpg");
    await this.storage.putObject(key, reencoded.buffer, reencoded.contentType); // شبكة — خارج أي ترانزاكشن (D9)
    await insertPodAttachment(this.handle.db, s.tenantId, order.id, key, s.driverId);
    return { outcome: "stored", publicCode: order.publicCode };
  }
}
