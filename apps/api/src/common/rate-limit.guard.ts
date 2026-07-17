import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { REDIS } from "../tokens.js";

// §11 — الطبقة الأولى من حد المعدل الثلاثي: **لكل IP على الـ API العام**. عدّاد Redis
// بنافذة ثابتة مشتركة عبر كل نسخ الـ API (توسّع أفقي §1) — نفس نمط عدّاد البوت
// (packages/telegram): INCR + EXPIRE عند أول طلب بالنافذة، والمبدأ نقي قابل للاختبار.
// حارس عام (APP_GUARD) يُسجَّل **قبل** SessionGuard فيُرفض الفيضان قبل أي عمل مصادقة.

/** الحد الأدنى البنيوي من Redis الذي يحتاجه الحدّ — ioredis يطابقه، والاختبار يحقن بديلاً. */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

/**
 * §1/§14 — الفشل المفتوح يتطلب فشلاً **سريعاً**: عميل ioredis المشترك (يخدم BullMQ)
 * مضبوط بـ maxRetriesPerRequest:null + offline queue، فأمرُه أثناء انقطاع Redis
 * **يعلّق** بدل أن يرمي — والـ catch لا يُبلَغ أبداً، فيتجمّد مسار الطلب بأكمله.
 * نسابق كل نداء بمهلة قصيرة: انتهاؤها = نعامله كخلل Redis ونفشل مفتوحين (لا نُسقط الـ API).
 */
export const RATE_LIMIT_REDIS_TIMEOUT_MS = 150;

class RedisTimeoutError extends Error {}

function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisTimeoutError("redis op timed out")), ms);
    op.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** طبقة حدّ = اسم (للمفتاح واللوغ) + سقف الطلبات + طول النافذة بالثواني. */
export interface RateTier {
  name: string;
  limit: number;
  windowS: number;
}

// السقوف بمكان واحد: العام واسع، ومسارات الإساءة (دخول/تتبّع عام) أضيق نافذةً.
export const RATE_TIERS = {
  // §11 — قوة غاشمة على الدخول: 10 محاولات/دقيقة لكل IP
  login: { name: "login", limit: 10, windowS: 60 },
  // §7/§11 — التتبّع العام مجهول وعرضة للإساءة: نافذة دقيقة أضيق burst من العام
  track: { name: "track", limit: 60, windowS: 60 },
  // العام على كل المسارات: 300 طلب/5 دقائق لكل IP
  global: { name: "global", limit: 300, windowS: 300 },
} as const satisfies Record<string, RateTier>;

/**
 * نقي: أي طبقة تنطبق على (method, path)؟ null = معفى من الحدّ:
 * - /health — مسبار الحياة (§14): 429 عليه = إنذار سقوط كاذب.
 * - /tg/* — webhook تيليغرام: 429 يجعل تيليغرام يعيد ويتراجع (له سرّ + inbox dedup أصلاً).
 * وإلا: دخول → طبقة login، تتبّع عام → طبقة track، والباقي → global.
 */
export function classifyRoute(method: string, rawPath: string): RateTier | null {
  // §11 — Express case-insensitive: نطبّع قبل التصنيف، وإلا مسار مختلط الأحرف
  // (/API/auth/login) يقع بالطبقة العامة الواسعة بدل طبقة الدخول الضيقة (تجاوز قوة غاشمة).
  const path = rawPath.toLowerCase();
  if (path === "/health" || path.startsWith("/health/")) return null;
  if (path === "/metrics") return null; // §13 — كشط Prometheus الداخلي: 429 عليه يعمي المراقبة
  if (path.startsWith("/tg/")) return null;
  // §11 — كل مسارات إثبات الهوية (كلمة سر أو TOTP، للطاقم أو المشرف) بطبقة login الأضيق:
  // قوة غاشمة على أيّها تُخنق بنفس الحد (10/دقيقة/IP) — بما فيها تخمين رمز TOTP السداسي.
  if (
    method === "POST" &&
    (path === "/api/auth/login" ||
      path === "/api/auth/totp/verify" ||
      path === "/api/admin/auth/login")
  ) {
    return RATE_TIERS.login;
  }
  if (path.startsWith("/public/track")) return RATE_TIERS.track;
  return RATE_TIERS.global;
}

/** نقي: هل تجاوز العدّاد (بعد الزيادة) السقف؟ */
export function fixedWindowExceeded(count: number, limit: number): boolean {
  return count > limit;
}

/** نقي: مفتاح العدّاد لكل (طبقة، IP). فصل الطبقات يمنع مسارَ إساءة من استنزاف حصّة الآخر. */
export function rateLimitKey(tier: string, ip: string): string {
  return `rl:api:${tier}:${ip}`;
}

/** مصدر IP الحد الأدنى — express Request يطابقه بنيوياً، والاختبار يمرّر شكلاً بسيطاً. */
export interface IpSource {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/**
 * §11 — آخر IP بترويسة X-Forwarded-For. **حرج أمنياً**: أقصى اليسار يتحكّم به المهاجم
 * (Caddy يُلحِق IP القرين الحقيقي لأي XFF يرسله العميل، لا يستبدله)، فأخذُه يُفرّغ كل
 * طبقات حد المعدل لكل IP (تخمين كلمات السر/TOTP بلا سقف + إغراق /api/miniapp/auth).
 * القرين الحقيقي = آخر مُدخَل يُلحقه الوكيل الموثوق الوحيد (Caddy). دفاع مضاعف:
 * Caddyfile يعيد ضبط XFF إلى {remote_host}. يقبل النص أو المصفوفة.
 */
function lastForwardedIp(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  // مصفوفة = عدة ترويسات XFF؛ آخر قيمة بآخر ترويسة هي التي ألحقها الوكيل الأقرب
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (raw === undefined) return undefined;
  const parts = raw.split(",");
  const last = parts[parts.length - 1]?.trim();
  return last !== undefined && last.length > 0 ? last : undefined;
}

/**
 * §11 — IP الحقيقي خلف Caddy: آخر مُدخَل بـ X-Forwarded-For (قفزة ثقة واحدة = Caddy،
 * وهو من يُلحق القرين الفعلي أخيراً) وإلا socket ip. المهاجم قد يسبق بمدخلات مزيّفة
 * لكن لا يستطيع الإلحاق بعد Caddy، فآخر مُدخَل غير قابل للتزوير بهذا الطوبولوجي.
 */
export function clientIp(req: IpSource): string {
  const forwarded = lastForwardedIp(req.headers["x-forwarded-for"]);
  if (forwarded !== undefined) return forwarded;
  const direct = req.ip ?? req.socket?.remoteAddress;
  return direct !== undefined && direct.length > 0 ? direct : "unknown";
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: RateLimitRedis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const tier = classifyRoute(req.method, req.path);
    if (tier === null) return true; // معفى (health / webhook)

    const ip = clientIp(req);
    const key = rateLimitKey(tier.name, ip);

    let count: number;
    try {
      count = await withTimeout(this.redis.incr(key), RATE_LIMIT_REDIS_TIMEOUT_MS);
      if (count === 1) {
        await withTimeout(this.redis.expire(key, tier.windowS), RATE_LIMIT_REDIS_TIMEOUT_MS); // نافذة تبدأ من أول طلب
      }
    } catch {
      // §1/§14 — نفشل **مفتوحين** وبسرعة: خلل/انقطاع Redis (رمي أو مهلة) يجب ألّا يُسقط
      // كل الـ API. الحدّ طبقة حماية لا بوابة صحّة؛ الإتاحة أولى.
      console.warn(JSON.stringify({ action: "rate_limit", outcome: "redis_error", tier: tier.name }));
      return true;
    }

    if (!fixedWindowExceeded(count, tier.limit)) return true;

    // تجاوز — Retry-After من TTL المتبقي؛ لو ضاع الـ TTL (‎-1/-2) أعِد تسليح النافذة.
    let retryAfter = tier.windowS;
    try {
      const ttl = await withTimeout(this.redis.ttl(key), RATE_LIMIT_REDIS_TIMEOUT_MS);
      if (ttl > 0) retryAfter = ttl;
      else await withTimeout(this.redis.expire(key, tier.windowS), RATE_LIMIT_REDIS_TIMEOUT_MS);
    } catch {
      /* أبقِ retryAfter = windowS */
    }

    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader("Retry-After", String(retryAfter));
    // §13 — لوغ منظّم للتحقيق بالإساءة؛ §11 — الرد جسم عام موحّد بلا تفاصيل.
    console.warn(
      JSON.stringify({ action: "rate_limit", outcome: "blocked", tier: tier.name, ip, path: req.path }),
    );
    throw new HttpException("too many requests", HttpStatus.TOO_MANY_REQUESTS);
  }
}
