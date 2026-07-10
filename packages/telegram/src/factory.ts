import { decryptSecret } from "@quickdrop/shared";
import { Bot, type Transformer } from "grammy";
import { assertTokenShape } from "./api.js";

// §4.1/§4.3 — مصنع بوت المستأجر: instance واحد لكل مستأجر عبر LRU بسيط،
// فك تشفير التوكن عند أول استخدام فقط، وparse_mode HTML افتراضياً على كل الإرسال.

export type { Bot } from "grammy";

/** §4.2 — غلاف فك تشفير توكن البوت (AES-256-GCM عبر decryptSecret) + تحقق شكل التوكن بلا طباعته. */
export function decryptBotToken(encrypted: Buffer, masterKey: Buffer): string {
  const token = decryptSecret(encrypted, masterKey);
  assertTokenShape(token); // ترمي بلا echo للتوكن — حتى الخاطئ قد يكون توكناً حقيقياً
  return token;
}

// §4.3 — الطرق التي تحمل parse_mode بالمستوى الأعلى: HTML حصراً (ممنوع Markdown legacy —
// رموزه بتنكسر بالأسماء العربية والإيموجي). النصوص القادمة من المستخدم تمر بـ escapeHtml (html.ts).
const PARSE_MODE_METHODS = new Set([
  "sendMessage",
  "copyMessage",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "editMessageText",
  "editMessageCaption",
]);

const htmlByDefault: Transformer = (prev, method, payload, signal) => {
  if (PARSE_MODE_METHODS.has(method) && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record["parse_mode"] === undefined) {
      // التحويل عبر unknown مقصود: Payload<M> اتحاد ضخم حسب الطريقة، والإضافة هنا
      // حقل parse_mode الاختياري نفسه بكل طرق PARSE_MODE_METHODS.
      const withHtml = { ...record, parse_mode: "HTML" } as unknown as typeof payload;
      return prev(method, withHtml, signal);
    }
  }
  return prev(method, payload, signal);
};

/**
 * §4.3 — بوت grammY مضبوط لمستأجر واحد:
 * - parse_mode افتراضي HTML على كل الإرسال/التعديل.
 * - bot.catch يسجّل JSON منظّماً (§13) **بلا التوكن أبداً** (§4.2): أي ظهور عرضي له
 *   برسالة خطأ (HttpError يحمل الـ URL مثلاً) يُمسح قبل اللوغ.
 */
export function createTenantBot(opts: { token: string; tenantId: string }): Bot {
  assertTokenShape(opts.token);
  const bot = new Bot(opts.token);

  bot.api.config.use(htmlByDefault);

  bot.catch((err) => {
    const cause = err.error;
    const rawMessage = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    // §4.2: التوكن لا يظهر أبداً — لا بالـ logs ولا برسائل الخطأ
    const message = rawMessage.split(opts.token).join("[redacted-token]");
    // §16.12: هذه المعالجة الصريحة النهائية لخطأ معالجات البوت — تُسجَّل ولا تُبتلع بصمت.
    // لا إعادة رمي: إعادة معالجة التحديث نفسه عبر الطابور قد تكرر رسائل للزبون (الفخ 7).
    console.error(
      JSON.stringify({
        action: "bot_error",
        tenantId: opts.tenantId,
        updateId: err.ctx.update.update_id,
        chatId: err.ctx.chat?.id ?? null,
        message,
      }),
    );
  });

  return bot;
}

// §4.1(4) — LRU بسيط حسب المستأجر: فك التشفير والإنشاء وinit (getMe) عند أول استخدام فقط.
// نخزّن Promise<Bot> لا Bot كي لا يُنشأ بوتان لنفس المستأجر بتحديثين متزامنين (الفخ 7).
// **تدوير التوكن أو تغيير bot_username → invalidateBot(tenantId) فوراً.**
const BOT_CACHE_MAX = 100;
const botCache = new Map<string, Promise<Bot>>();

export async function getBotForTenant(opts: {
  tenantId: string;
  token: string;
  /** يُستدعى مرة واحدة عند الإنشاء الأول — هنا تُسجَّل المعالجات (registerCustomerFlow). */
  onCreate?: (bot: Bot) => void;
}): Promise<Bot> {
  const cached = botCache.get(opts.tenantId);
  if (cached) {
    // لمسة LRU: أعد الإدراج بآخر الخريطة (Map يحفظ ترتيب الإدراج)
    botCache.delete(opts.tenantId);
    botCache.set(opts.tenantId, cached);
    return cached;
  }

  const creating = (async () => {
    const bot = createTenantBot({ token: opts.token, tenantId: opts.tenantId });
    opts.onCreate?.(bot);
    await bot.init(); // مرة واحدة لكل instance — handleUpdate يتطلب botInfo جاهزاً
    return bot;
  })();

  botCache.set(opts.tenantId, creating);
  if (botCache.size > BOT_CACHE_MAX) {
    // اطرد الأقدم استخداماً (أول مفتاح بالترتيب)
    const oldest = botCache.keys().next();
    if (!oldest.done) botCache.delete(oldest.value);
  }

  try {
    return await creating;
  } catch (error) {
    // فشل init (شبكة/توكن مدوَّر) لا يبقى مسموماً بالكاش — المحاولة التالية تعيد الإنشاء
    if (botCache.get(opts.tenantId) === creating) botCache.delete(opts.tenantId);
    throw error;
  }
}

/** §4.1(4) — إبطال فوري لـ entry المستأجر عند تدوير التوكن أو تغيير bot_username. */
export function invalidateBot(tenantId: string): void {
  botCache.delete(tenantId);
}
