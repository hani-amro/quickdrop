import { HttpException, HttpStatus } from "@nestjs/common";
import { z } from "zod";
import { fixedWindowExceeded } from "./rate-limit.guard.js";

// §11 — الطبقة الثالثة من حد المعدل الثلاثي: **لكل مستأجر على الموارد المشتركة**
// (البث، ولاحقاً OSRM) — "حماية الجيران المزعجين". عدّاد Redis بنافذة ثابتة لكل
// (مستأجر، مورد)؛ يُستدعى من مسار الإنشاء ويرمي 429 عند التجاوز. المبدأ نقي قابل للاختبار.

/** نفس الحد الأدنى البنيوي من Redis كالحارس — ioredis يطابقه، والاختبار يحقن بديلاً. */
export interface TenantRateRedis {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

/** نقي: مفتاح العدّاد لكل (مورد، مستأجر). */
export function tenantResourceKey(tenantId: string, resource: string): string {
  return `rl:tenant:${resource}:${tenantId}`;
}

// البث: افتراضي 5/يوم لكل مستأجر. النافذة ثابتة 24 ساعة تبدأ من أول بثّة (تبسيط
// النافذة الثابتة — نفس فلسفة عدّاد البوت)، لا محاذاة لتقويم اليوم.
export const DEFAULT_BROADCAST_PER_DAY = 5;
export const BROADCAST_WINDOW_S = 86_400;
export const BROADCAST_RESOURCE = "broadcast";

// §11 — ما يعود من tenants.limits (jsonb) مدخل خارجي: يمر بـ Zod بحدود عاقلة.
const perDaySchema = z.number().int().min(0).max(100_000);

/**
 * نقي: يقرأ سقف البث/اليوم من tenants.limits.broadcast_per_day، وإلا الافتراضي.
 * limits شكلها حرّ (jsonb) — نتحقق منها بدل الثقة بها.
 */
export function readBroadcastPerDay(limits: unknown): number {
  if (typeof limits === "object" && limits !== null && !Array.isArray(limits)) {
    const parsed = perDaySchema.safeParse((limits as Record<string, unknown>)["broadcast_per_day"]);
    if (parsed.success) return parsed.data;
  }
  return DEFAULT_BROADCAST_PER_DAY;
}

/**
 * §11 — يزيد عدّاد المورد للمستأجر ويرمي 429 عند تجاوز السقف. الزيادة أولاً (ذرّية،
 * فشل سريع قبل أي عمل ثقيل). عند التجاوز: Retry-After بالثواني بالجسم (لا res هنا).
 * خلل Redis عابر → نفشل مفتوحين (§14): حماية الجيران لا تُسقط عملية.
 */
export async function assertTenantResource(
  redis: TenantRateRedis,
  tenantId: string,
  resource: string,
  limit: number,
  windowS: number,
): Promise<void> {
  const key = tenantResourceKey(tenantId, resource);

  let count: number;
  try {
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowS); // نافذة تبدأ من أول استهلاك
  } catch {
    console.warn(
      JSON.stringify({ action: "tenant_rate", outcome: "redis_error", tenant_id: tenantId, resource }),
    );
    return; // fail open (§14)
  }

  if (!fixedWindowExceeded(count, limit)) return;

  let retryAfter = windowS;
  try {
    const ttl = await redis.ttl(key);
    if (ttl > 0) retryAfter = ttl;
    else await redis.expire(key, windowS); // مفتاح بلا TTL — أعِد تسليحه
  } catch {
    /* أبقِ retryAfter = windowS */
  }

  console.warn(
    JSON.stringify({ action: "tenant_rate", outcome: "blocked", tenant_id: tenantId, resource, limit }),
  );
  // §11 — رد عام موحّد؛ retryAfter بالثواني كي يحترمه العميل.
  throw new HttpException(
    { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "too many requests", retryAfter },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
