import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  clientIp,
  fixedWindowExceeded,
  RATE_TIERS,
  rateLimitKey,
  RateLimitGuard,
} from "./rate-limit.guard.js";
import {
  assertTenantResource,
  DEFAULT_BROADCAST_PER_DAY,
  readBroadcastPerDay,
  tenantResourceKey,
  type TenantRateRedis,
} from "./tenant-rate.js";

// اختبارات pure فقط (§15) — منطق النافذة واشتقاق المفتاح واستخراج الـ IP بلا Redis
// حقيقي؛ الحدّ لكل مستأجر يُختبر بـ Redis مزيّف (Map) بلا أي اتصال.

describe("fixedWindowExceeded — العدّاد بعد الزيادة مقابل السقف", () => {
  it("لا يتجاوز عند ما دون السقف أو عنده تماماً", () => {
    expect(fixedWindowExceeded(1, 10)).toBe(false);
    expect(fixedWindowExceeded(10, 10)).toBe(false); // الطلب رقم 10 مسموح
  });
  it("يتجاوز عند أول طلب فوق السقف", () => {
    expect(fixedWindowExceeded(11, 10)).toBe(true);
    expect(fixedWindowExceeded(301, 300)).toBe(true);
  });
});

describe("classifyRoute — تصنيف المسار لطبقة الحدّ", () => {
  it("يعفي مسبار الحياة و webhook تيليغرام وواتساب (null)", () => {
    expect(classifyRoute("GET", "/health")).toBeNull();
    expect(classifyRoute("GET", "/health/ready")).toBeNull();
    expect(classifyRoute("POST", "/tg/acme")).toBeNull();
    // مراجعة Phase 1 (HIGH): بوابة واتساب معفاة كالتيليغرام (توقيع + inbox dedup)
    expect(classifyRoute("POST", "/wa/webhook")).toBeNull();
    expect(classifyRoute("GET", "/wa/webhook")).toBeNull();
  });
  it("POST /api/auth/login → طبقة login الأضيق", () => {
    expect(classifyRoute("POST", "/api/auth/login")).toBe(RATE_TIERS.login);
  });
  it("POST مسارات إثبات الهوية الأخرى (TOTP + دخول المشرف) → طبقة login", () => {
    expect(classifyRoute("POST", "/api/auth/totp/verify")).toBe(RATE_TIERS.login);
    expect(classifyRoute("POST", "/api/admin/auth/login")).toBe(RATE_TIERS.login);
  });
  it("انحدار: شرطة زائدة على مسار الدخول تبقى بطبقة login (لا تنزلق للعامة الواسعة)", () => {
    expect(classifyRoute("POST", "/api/auth/login/")).toBe(RATE_TIERS.login);
    expect(classifyRoute("POST", "/api/auth/totp/verify/")).toBe(RATE_TIERS.login);
    expect(classifyRoute("POST", "/API/Admin/Auth/Login/")).toBe(RATE_TIERS.login); // حالة + شرطة
  });
  it("GET على مسار الدخول ليس قوة غاشمة → العام", () => {
    expect(classifyRoute("GET", "/api/auth/login")).toBe(RATE_TIERS.global);
  });
  it("التتبّع العام (أي توكن) → طبقة track", () => {
    expect(classifyRoute("GET", "/public/track/deadbeefdeadbeefdeadbeefdeadbeef")).toBe(RATE_TIERS.track);
  });
  it("بقية مسارات الـ API → العام", () => {
    expect(classifyRoute("GET", "/api/orders")).toBe(RATE_TIERS.global);
    expect(classifyRoute("POST", "/api/broadcasts")).toBe(RATE_TIERS.global);
  });
  it("يعفي /metrics (كشط Prometheus)", () => {
    expect(classifyRoute("GET", "/metrics")).toBeNull();
  });
});

describe("RateLimitGuard — الفشل المفتوح السريع عند تعليق Redis (§1/§14)", () => {
  // Redis يحاكي انقطاعاً: incr لا يُحلّ أبداً (كما مع maxRetriesPerRequest:null)
  const hangingRedis = {
    incr: () => new Promise<number>(() => {}), // معلّق للأبد
    expire: () => new Promise<unknown>(() => {}),
    ttl: () => new Promise<number>(() => {}),
  };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ method: "GET", path: "/api/orders", headers: {}, ip: "1.2.3.4" }),
      getResponse: () => ({ setHeader: () => {} }),
    }),
  } as unknown as Parameters<RateLimitGuard["canActivate"]>[0];

  it("يفشل مفتوحاً (true) خلال مهلة قصيرة بدل التعليق للأبد", async () => {
    const guard = new RateLimitGuard(hangingRedis);
    const start = Date.now();
    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true); // §14 — الإتاحة أولى، الحدّ ليس بوابة صحّة
    expect(Date.now() - start).toBeLessThan(1000); // لم يعلّق
  });
});

describe("rateLimitKey — اشتقاق المفتاح لكل (طبقة، IP)", () => {
  it("يفصل الطبقات والـ IPs بمفاتيح مستقلة", () => {
    expect(rateLimitKey("global", "1.2.3.4")).toBe("rl:api:global:1.2.3.4");
    expect(rateLimitKey("login", "1.2.3.4")).toBe("rl:api:login:1.2.3.4");
    expect(rateLimitKey("global", "1.2.3.4")).not.toBe(rateLimitKey("global", "5.6.7.8"));
  });
});

describe("clientIp — IP الحقيقي خلف Caddy (آخر مُدخَل)", () => {
  it("يأخذ آخر مُدخَل بـ X-Forwarded-For (القرين الذي ألحقه Caddy)", () => {
    expect(clientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } })).toBe("10.0.0.1");
  });
  it("لا يُخدَع بمدخلات مزيّفة يسبق بها المهاجم (تجاوز حد المعدل — HIGH)", () => {
    // المهاجم يرسل XFF مزيّفاً، وCaddy يُلحق قرينه الحقيقي أخيراً → آخر مُدخَل هو الصادق
    expect(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.7" } })).toBe("203.0.113.7");
    expect(clientIp({ headers: { "x-forwarded-for": "forged-junk, 203.0.113.7" } })).toBe("203.0.113.7");
  });
  it("يقصّ الفراغات ويأخذ آخر عنصر عند تعدّد ترويسات XFF (مصفوفة)", () => {
    expect(clientIp({ headers: { "x-forwarded-for": "  10.0.0.1  " } })).toBe("10.0.0.1");
    expect(clientIp({ headers: { "x-forwarded-for": ["9.9.9.9", "10.0.0.1"] } })).toBe("10.0.0.1");
    expect(clientIp({ headers: { "x-forwarded-for": ["1.1.1.1, 2.2.2.2"] } })).toBe("2.2.2.2");
  });
  it("يسقط إلى req.ip ثم socket.remoteAddress عند غياب الترويسة", () => {
    expect(clientIp({ headers: {}, ip: "7.7.7.7" })).toBe("7.7.7.7");
    expect(clientIp({ headers: {}, socket: { remoteAddress: "8.8.8.8" } })).toBe("8.8.8.8");
  });
  it("يرجّع 'unknown' حين لا مصدر (لا يرمي)", () => {
    expect(clientIp({ headers: {} })).toBe("unknown");
    expect(clientIp({ headers: { "x-forwarded-for": "   " } })).toBe("unknown");
  });
});

describe("readBroadcastPerDay — قراءة السقف من tenants.limits", () => {
  it("يقرأ broadcast_per_day الصحيح", () => {
    expect(readBroadcastPerDay({ broadcast_per_day: 20 })).toBe(20);
    expect(readBroadcastPerDay({ broadcast_per_day: 0 })).toBe(0);
  });
  it("يسقط للافتراضي عند الغياب/الشكل الخاطئ", () => {
    expect(readBroadcastPerDay({})).toBe(DEFAULT_BROADCAST_PER_DAY);
    expect(readBroadcastPerDay(null)).toBe(DEFAULT_BROADCAST_PER_DAY);
    expect(readBroadcastPerDay({ broadcast_per_day: "5" })).toBe(DEFAULT_BROADCAST_PER_DAY);
    expect(readBroadcastPerDay({ broadcast_per_day: -1 })).toBe(DEFAULT_BROADCAST_PER_DAY);
    expect(readBroadcastPerDay([1, 2, 3])).toBe(DEFAULT_BROADCAST_PER_DAY);
  });
});

// Redis مزيّف: Map للعدّادات وأخرى للـ TTL — بلا أي اتصال (§15).
class FakeRedis implements TenantRateRedis {
  private readonly counts = new Map<string, number>();
  private readonly ttls = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async expire(key: string, ttlSeconds: number): Promise<number> {
    this.ttls.set(key, ttlSeconds);
    return 1;
  }
  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -1;
  }
}

describe("assertTenantResource — حدّ المستأجر على مورد مشترك", () => {
  it("يسمح حتى السقف ثم يرمي 429 على أول تجاوز", async () => {
    const redis = new FakeRedis();
    await assertTenantResource(redis, "t1", "broadcast", 2, 100); // 1
    await assertTenantResource(redis, "t1", "broadcast", 2, 100); // 2 = السقف، مسموح
    await expect(assertTenantResource(redis, "t1", "broadcast", 2, 100)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it("429 يحمل retryAfter من TTL المتبقي", async () => {
    const redis = new FakeRedis();
    await assertTenantResource(redis, "t1", "broadcast", 1, 100); // يضبط TTL=100
    try {
      await assertTenantResource(redis, "t1", "broadcast", 1, 100);
      expect.unreachable("كان يجب أن يرمي");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const err = error as HttpException;
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toMatchObject({ retryAfter: 100 });
    }
  });

  it("مستأجرون مختلفون حصص مستقلة (لا تسرّب بين الجيران)", async () => {
    const redis = new FakeRedis();
    await assertTenantResource(redis, "t1", "broadcast", 1, 100);
    // t2 له عدّاده الخاص — لا يتأثر بامتلاء t1
    await expect(assertTenantResource(redis, "t2", "broadcast", 1, 100)).resolves.toBeUndefined();
  });

  it("يفشل مفتوحاً عند خلل Redis (لا يُسقط العملية)", async () => {
    const throwing: TenantRateRedis = {
      incr: () => Promise.reject(new Error("redis down")),
      expire: () => Promise.resolve(1),
      ttl: () => Promise.resolve(-1),
    };
    await expect(assertTenantResource(throwing, "t1", "broadcast", 1, 100)).resolves.toBeUndefined();
  });
});

describe("tenantResourceKey — مفتاح لكل (مورد، مستأجر)", () => {
  it("يفصل الموارد والمستأجرين", () => {
    expect(tenantResourceKey("t1", "broadcast")).toBe("rl:tenant:broadcast:t1");
    expect(tenantResourceKey("t1", "osrm")).not.toBe(tenantResourceKey("t1", "broadcast"));
  });
});
