import {
  broadcasts,
  enqueueBroadcast,
  recordBroadcastResult,
  tenants,
  users,
  withTenant,
  type BroadcastAudienceMember,
  type Db,
} from "@quickdrop/db";
import type { BroadcastJob } from "@quickdrop/shared";
import {
  decryptBotToken,
  escapeHtml,
  getBotForTenant,
  registerCustomerFlow,
  type Bot,
  type ConvRedis,
} from "@quickdrop/telegram";
import { and, eq, isNull } from "drizzle-orm";
import { GrammyError } from "grammy";

// §4.3/§14 v1.1 — مستهلك البث: مهمة واحدة لكل بثّة. يجلب الجمهور (enqueueBroadcast
// يعلّم 'sending' ويعيد المستهدفين) ثم يرسل رسالة لكل مستخدم عبر بوت المستأجر **مع
// احترام حدّ المعدل** (~30 msg/s لكل بوت §4.3)، ويسجّل sent/failed (recordBroadcastResult).
//
// idempotency (§12): jobId حتمي = broadcastId؛ enqueueBroadcast يميّز البثّة المنتهية
// سلفاً (alreadyFinalized) فلا يُعاد إرسالها بإعادة الجدولة. كل نداءات تيليغرام هنا
// خارج أي ترانزاكشن قاعدة (الترانزاكشنات قراءة/تحديث أعمدة فقط).
//
// استئناف لا إعادة بثّ (§12): 'sending' حالة **قابلة للاستئناف** لا منتهية. لو انهارت
// المهمة أو تعلّقت (BullMQ attempts/stalled) بعد وسمها 'sending' وقبل recordBroadcastResult،
// تُعاد تشغيلها فيعود الجمهور كاملاً من enqueueBroadcast — لكن مجموعة bcast:sent:{id} بـ Redis
// تجعل الحلقة تتخطّى كل من سُلِّم إليه، فلا يُرسَل إلا الذيل (لا إرسال مكرّر للكل). العدّ
// النهائي مشتقّ من SCARD المجموعتين لا من عدّاد الجولة → مطلق ثابت مهما تكرّر الاستئناف.
//
// أخطاء المستقبِل الفردية تُلتقط وتُعدّ (لا رمي) — فلا يُسقط مستقبِل واحد البثّة كلها
// ولا يعيد بثّها من الصفر. الرمي (retry) يقتصر على الأعطال النُّظُمية (تحميل المستأجر/فك
// التوكن) قبل أي إرسال — آمن، والاستئناف بمجموعة التسليم يتخطّى ما سبق إرساله.

export interface BroadcastConsumerDeps {
  /** دور app_user — كل قراءة/كتابة ضمن مستأجر عبر withTenant حصراً (§2.3). */
  appDb: Db;
  /** قراءة صف المستأجر نفسه (جدول tenants — استثناء RLS مسمّى §2.3). */
  scanDb: Db;
  /** §4.2: MASTER_KEY (32 بايت) لفك تشفير bot_token_encrypted. */
  masterKey: Buffer;
  /**
   * حالة المحادثة (تسجيل تدفق البوت عند الإنشاء الأول بالـ LRU) **و** مجموعات "المُسلَّم
   * إليهم" لكل بثّة (§12) — عميل ioredis واحد يطابق الواجهتين بنيوياً.
   */
  redis: ConvRedis & BroadcastSetRedis;
}

// §12 — استئناف لا إعادة بثّ: مجموعتان بـ Redis لكل بثّة (أخفّ من جدول جديد، صحيح كفايةً v1):
//   bcast:sent:{id}   — من سُلِّم إليه بنجاح → يُتخطّى عند إعادة المحاولة (checkpoint لكل مستقبِل).
//   bcast:failed:{id} — من تعذّر تسليمه نهائياً (حظر البوت 403) → للعدّ فقط.
// المحظور يُقصى أصلاً من جمهور enqueueBroadcast (blocked_at IS NULL §4.3)، فيكفي فحص bcast:sent
// وحده للتخطّي. الفشل العابر (غير 403) لا يُثبَّت في أي مجموعة → يُعاد محاولته عند الاستئناف.

/** الحدّ الأدنى البنيوي لعميل Redis لمجموعات التسليم (ioredis يطابقه؛ الاختبار الصافي يستبدله بـ Map §15). */
export interface BroadcastSetRedis {
  sismember(key: string, member: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  scard(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
}

// §12 — TTL أسبوع: يفوق أطول نافذة إعادة محاولة/DLQ ثم تُنظَّف المجموعة تلقائياً (لا تسرّب ذاكرة Redis).
export const BROADCAST_DELIVERED_TTL_S = 7 * 24 * 60 * 60;

/** §12 — مفتاح مجموعة من سُلِّم إليهم بنجاح لهذه البثّة. */
export function sentSetKey(broadcastId: string): string {
  return `bcast:sent:${broadcastId}`;
}

/** §12 — مفتاح مجموعة من تعذّر تسليمهم نهائياً (حظر) لهذه البثّة. */
export function failedSetKey(broadcastId: string): string {
  return `bcast:failed:${broadcastId}`;
}

/**
 * §12 (نقي، قابل للاختبار) — هل سُلِّم لهذا المستقبِل في جولة سابقة؟ يُتخطّى إن نعم.
 * المحظور مُقصى من الجمهور أصلاً (blocked_at)، فالفحص على مجموعة النجاح وحدها يكفي.
 */
export async function isAlreadyDelivered(
  redis: BroadcastSetRedis,
  broadcastId: string,
  userId: string,
): Promise<boolean> {
  return (await redis.sismember(sentSetKey(broadcastId), userId)) === 1;
}

/** §12 — سجّل عضواً في مجموعة تسليم (SADD idempotent) مع ضبط/تجديد TTL أسبوع عند كل إضافة فعلية. */
export async function recordInDeliverySet(redis: BroadcastSetRedis, key: string, userId: string): Promise<void> {
  const added = await redis.sadd(key, userId);
  if (added > 0) await redis.expire(key, BROADCAST_DELIVERED_TTL_S);
}

// §4.3 — الحدّ ~30 msg/s لكل بوت. تأخير بسيط بين الرسائل (25/s < 30/s) يبقينا تحت السقف
// دون throttler خارجي؛ كل مستقبِل محادثة مختلفة فلا يمسّ حدّ 1 msg/s لنفس المحادثة.
export const BROADCAST_MSG_INTERVAL_MS = 40;

// §4.3 — 429: احترم retry_after ثم أعد المحاولة مرة واحدة قبل عدّها فشلاً (تجاهله = حظر البوت).
const MAX_RATE_LIMIT_RETRIES = 1;
const RATE_LIMIT_JITTER_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** §4.3 — 403 Forbidden: المستخدم حظر البوت → blocked_at ولا إعادة محاولة. */
export function isBlockedByUser(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 403;
}

/** §4.3 — 429 Too Many Requests: تجاوزنا الحدّ؛ اقرأ retry_after ونم المدة + jitter. */
export function isRateLimited(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 429;
}

/** §4.3 — مدة الانتظار بعد 429: retry_after (ث→مللي) أو ثانية افتراضياً، + jitter عشوائي. */
export function retryAfterMs(error: GrammyError): number {
  const retryAfter = (error.parameters as { retry_after?: number } | undefined)?.retry_after;
  const base = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1000 : 1000;
  return base + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
}

interface ActiveTenant {
  currency: string;
  botTokenEncrypted: Buffer | null;
}

/** صف المستأجر (scanDb — استثناء RLS مسمّى §2.3). معلّق/مؤرشف → null (لا يُبثّ باسمه شيء §14). */
async function loadActiveTenant(deps: BroadcastConsumerDeps, tenantId: string): Promise<ActiveTenant | null> {
  const rows = await deps.scanDb
    .select({ status: tenants.status, currency: tenants.currency, botTokenEncrypted: tenants.botTokenEncrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenant = rows[0];
  if (!tenant) {
    // §16.12: لا ابتلاع — مستأجر مجهول لبثّة قائمة فساد بيانات يستحق DLQ وتنبيهاً
    throw new Error(`broadcast: tenant ${tenantId} not found`);
  }
  if (tenant.status === "suspended" || tenant.status === "churned") {
    return null;
  }
  return { currency: tenant.currency, botTokenEncrypted: tenant.botTokenEncrypted };
}

/** bot من الـ LRU (§4.1-4) — نفس تسجيل مستهلك الإشعارات كي يكون الـ instance المتشارك مكتمل المعالجات. */
async function getTenantBot(deps: BroadcastConsumerDeps, tenantId: string, tenant: ActiveTenant): Promise<Bot> {
  if (!tenant.botTokenEncrypted) {
    throw new Error(`broadcast: tenant ${tenantId} has no bot token configured`);
  }
  const token = decryptBotToken(tenant.botTokenEncrypted, deps.masterKey);
  return getBotForTenant({
    tenantId,
    token,
    onCreate: (created) =>
      registerCustomerFlow(created, {
        db: deps.appDb,
        redis: deps.redis,
        tenantId,
        currency: tenant.currency,
      }),
  });
}

/** §4.3 — 403: علّم users.blocked_at (إن لم يكن معلَّماً) وأوقف كل إشعاراته. */
async function markUserBlocked(deps: BroadcastConsumerDeps, tenantId: string, userId: string): Promise<void> {
  console.warn(JSON.stringify({ action: "telegram_user_blocked_bot", tenantId, userId }));
  await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .update(users)
      .set({ blockedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.blockedAt))),
  );
}

// §4.3 — نص البثّة: العنوان عريض فوق النص، وكلاهما يُهرَّب HTML (قد يحمل رموزاً كاسرة).
export function broadcastText(title: string | null, body: string): string {
  const safeBody = escapeHtml(body);
  if (title === null || title.trim() === "") return safeBody;
  return `<b>${escapeHtml(title)}</b>\n\n${safeBody}`;
}

// §12 — نميّز الحظر (403، فشل نهائي: يُعدّ فشلاً ويُقصى من الجمهور بـ blocked_at) عن الفشل
// العابر (لا يُثبَّت في أي مجموعة → يُعاد محاولته عند الاستئناف). كلاهما يُعدّ ضمن failed_count.
type SendOutcome = "sent" | "blocked" | "failed";

/**
 * إرسال رسالة بثّة لمستقبِل واحد مع معالجة الحدود:
 * - 429: نم retry_after + jitter وأعد المحاولة (حتى MAX_RATE_LIMIT_RETRIES).
 * - 403: علّم blocked_at وأرجِع "blocked" (فشل نهائي، لا إعادة محاولة).
 * - أي خطأ آخر: لوغ منظّم وأرجِع "failed" (فشل عابر) — مستقبِل واحد فاشل لا يُسقط البثّة
 *   كلها ولا يُعيدها من الصفر (إعادة الرمي = بثّ مكرّر للكل §4.3). معالجة صريحة لا ابتلاع (§16.12).
 */
async function sendToMember(
  deps: BroadcastConsumerDeps,
  args: { tenantId: string; broadcastId: string; bot: Bot; member: BroadcastAudienceMember; text: string },
): Promise<SendOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await args.bot.api.sendMessage(args.member.telegramUserId, args.text);
      return "sent";
    } catch (error: unknown) {
      if (isRateLimited(error) && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(retryAfterMs(error));
        continue;
      }
      if (isBlockedByUser(error)) {
        await markUserBlocked(deps, args.tenantId, args.member.userId);
        return "blocked";
      }
      console.error(
        JSON.stringify({
          action: "broadcast_send_failed",
          tenantId: args.tenantId,
          broadcastId: args.broadcastId,
          userId: args.member.userId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return "failed";
    }
  }
}

/**
 * §4.3/§14 — معالج طابور البث (BROADCAST_QUEUE): مهمة واحدة لكل بثّة.
 * §16.12: لا ابتلاع أخطاء — فشل المستأجر المجهول أو فك التشفير يُرمى (retry ثم DLQ)؛
 * أخطاء المستقبِل الفردية تُعالَج صراحةً وتُعدّ، فلا يُعاد بثّ الكل بإعادة الجدولة.
 */
export function createBroadcastProcessor(deps: BroadcastConsumerDeps): (job: BroadcastJob) => Promise<void> {
  return async (job) => {
    const tenant = await loadActiveTenant(deps, job.tenantId);
    if (!tenant) {
      // §14 — مستأجر معلّق/مؤرشف: لا بثّ باسمه؛ أنهِ البثّة صفرية كي لا تبقى 'sending' أبداً
      console.log(
        JSON.stringify({ action: "broadcast_skipped_tenant_inactive", tenantId: job.tenantId, broadcastId: job.broadcastId }),
      );
      await recordBroadcastResult(deps.appDb, job.tenantId, job.broadcastId, { sent: 0, failed: 0 });
      return;
    }

    const { alreadyFinalized, audience } = await enqueueBroadcast(deps.appDb, job.tenantId, job.broadcastId);
    if (alreadyFinalized) {
      // إعادة جدولة at-least-once لبثّة منتهية: تجاهُل صامت (لا لمس للعدّادات §12)
      console.log(
        JSON.stringify({ action: "broadcast_already_finalized", tenantId: job.tenantId, broadcastId: job.broadcastId }),
      );
      return;
    }

    // النص من صف البثّة (المصدر الوحيد) — قراءة عمود عادي عبر withTenant (§2.3)
    const bcastRows = await withTenant(deps.appDb, job.tenantId, (tx) =>
      tx
        .select({ title: broadcasts.title, body: broadcasts.body })
        .from(broadcasts)
        .where(eq(broadcasts.id, job.broadcastId))
        .limit(1),
    );
    const bcast = bcastRows[0];
    if (!bcast) {
      throw new Error(`broadcast: ${job.broadcastId} not found after enqueue`); // §16.12
    }

    const bot = await getTenantBot(deps, job.tenantId, tenant);
    const text = broadcastText(bcast.title, bcast.body);

    // §12 — استئناف لا إعادة بثّ: تخطَّ من سُلِّم إليه سابقاً (bcast:sent)، أرسل الذيل فقط.
    const sentKey = sentSetKey(job.broadcastId);
    const failedKey = failedSetKey(job.broadcastId);
    let skipped = 0;
    let transientFailed = 0; // فشل عابر لهذه الجولة فقط (غير مثبَّت — يُعاد محاولته عند الاستئناف)
    for (const member of audience) {
      if (await isAlreadyDelivered(deps.redis, job.broadcastId, member.userId)) {
        skipped += 1; // سُلِّم في جولة سابقة — لا إرسال ولا تأخير معدّل، يمرّ الذيل سريعاً
        continue;
      }
      const outcome = await sendToMember(deps, { tenantId: job.tenantId, broadcastId: job.broadcastId, bot, member, text });
      if (outcome === "sent") {
        await recordInDeliverySet(deps.redis, sentKey, member.userId); // checkpoint: لن يُعاد إرساله
      } else if (outcome === "blocked") {
        // فشل نهائي (حظر): ثبّته للعدّ؛ blocked_at يقصيه أصلاً من جمهور أي استئناف
        await recordInDeliverySet(deps.redis, failedKey, member.userId);
      } else {
        transientFailed += 1; // فشل عابر: لا يُثبَّت كي يُعاد محاولته لو استُؤنفت المهمة
      }
      // §4.3 — احترام حدّ المعدل: تأخير بسيط بعد كل إرسال فعلي (لا بعد التخطّي)
      await sleep(BROADCAST_MSG_INTERVAL_MS);
    }

    // §12 — العدّ النهائي **مطلق** مشتقّ من المجموعتين (لا عدّاد جولة): ثابت مهما تكرّر الاستئناف.
    // sent = كل من سُلِّم إليه عبر كل الجولات؛ failed = الحظر المثبَّت + الفشل العابر لهذه الجولة.
    const sent = await deps.redis.scard(sentKey);
    const failed = (await deps.redis.scard(failedKey)) + transientFailed;

    await recordBroadcastResult(deps.appDb, job.tenantId, job.broadcastId, { sent, failed });
    console.log(
      JSON.stringify({
        action: "broadcast_done",
        tenantId: job.tenantId,
        broadcastId: job.broadcastId,
        sent,
        failed,
        skipped,
        audience: audience.length,
      }),
    );
  };
}
