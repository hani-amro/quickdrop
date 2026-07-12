import { createOrder, orders, quoteForTenant, users, withTenant, type Db, type User } from "@quickdrop/db";
import { bumpOrderRate, isOverLimit } from "./rate-limit.js";
import { fromTelegram, makePoint, type Service } from "@quickdrop/shared";
import { eq } from "drizzle-orm";
import { InlineKeyboard, Keyboard, type Bot, type Context } from "grammy";
import { clearConv, loadConv, saveConv, type ConvRedis } from "./conversation.js";
import { escapeHtml, orderCard, quoteCard } from "./html.js";

// §4.4 v1.1 — تدفق إنشاء طلب الزبون (p2p/parcel): اختيار خدمة ← موقع استلام ← موقع تسليم
// ← **عرض السعر مفصّلاً + تأكيد صريح قبل إنشاء أي صف** ← بطاقة الطلب.
// الحالة بـ Redis (conversation.ts)، والأزرار callback_data قصيرة — حد 64 بايت.

export interface CustomerFlowDeps {
  db: Db;
  redis: ConvRedis;
  tenantId: string;
  /** عملة المستأجر (tenants.currency) — للعرض فقط عبر formatMoney (D5). */
  currency: string;
}

// نصوص أزرار القائمة — ثابتة كي يطابقها bot.hears حرفياً
export const BTN_P2P = "🛵 طلب توصيل";
export const BTN_PARCEL = "📦 إرسال طرد";

// callback_data قصيرة (§4.4: حد 64 بايت — معرّفات قصيرة، لا JSON)
export const CB_CONFIRM = "ord:confirm";
export const CB_CANCEL = "ord:cancel";

const GENERIC_ERROR_AR = "عذراً، صار عندنا خطأ مؤقت 🙏 جرّب مرة تانية بعد شوي.";

function mainMenuKeyboard(): Keyboard {
  return new Keyboard().text(BTN_P2P).text(BTN_PARCEL).resized();
}

function phoneKeyboard(): Keyboard {
  // §3 v1.1 — تدفق التقاط الهاتف: زر request_contact
  return new Keyboard().requestContact("📱 مشاركة رقم الهاتف").resized().oneTime();
}

function locationKeyboard(): Keyboard {
  return new Keyboard().requestLocation("📍 مشاركة الموقع").resized().oneTime();
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ تأكيد الطلب", CB_CONFIRM).text("❌ إلغاء", CB_CANCEL);
}

/**
 * §11 — أي خطأ بمعالج: رسالة عربية لطيفة **عامة** للزبون، والتفاصيل باللوغ فقط (JSON §13).
 * §16.12 — معالجة صريحة + تسجيل، لا ابتلاع صامت؛ ولا إعادة رمي: إعادة تشغيل التحديث
 * عبر الطابور قد تكرر إنشاء طلب أو رسائل (الفخ 7).
 */
function guard<C extends Context>(
  deps: CustomerFlowDeps,
  action: string,
  handler: (ctx: C) => Promise<void>,
): (ctx: C) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      console.error(
        JSON.stringify({
          action: "customer_flow_error",
          flow: action,
          tenantId: deps.tenantId,
          updateId: ctx.update.update_id,
          chatId: ctx.chat?.id ?? null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
      try {
        await ctx.reply(GENERIC_ERROR_AR);
      } catch (replyError) {
        // المستخدم حظر البوت (403 §4.3) أو الشبكة ساقطة — الخطأ الأصلي مسجَّل أعلاه
        console.error(
          JSON.stringify({
            action: "customer_flow_error_reply_failed",
            tenantId: deps.tenantId,
            chatId: ctx.chat?.id ?? null,
            error: replyError instanceof Error ? replyError.message : String(replyError),
          }),
        );
      }
    }
  };
}

/** إن لم يكن للمستخدم صف users → أنشئه (D15: telegram_user_id قابل لـ NULL لكن هنا معروف). */
async function ensureCustomer(deps: CustomerFlowDeps, from: { id: number; first_name: string }): Promise<User> {
  return withTenant(deps.db, deps.tenantId, async (tx) => {
    // eq على telegram_user_id يكفي — RLS يحصر الصفوف بالمستأجر الحالي (§2.2)
    const found = await tx.select().from(users).where(eq(users.telegramUserId, from.id)).limit(1);
    const existing = found[0];
    if (existing) return existing;

    const inserted = await tx
      .insert(users)
      .values({ tenantId: deps.tenantId, telegramUserId: from.id, role: "customer", firstName: from.first_name })
      .onConflictDoNothing()
      .returning();
    const created = inserted[0];
    if (created) return created;

    // الفخ 7: /start مزدوج متسابق — الصف انزرع بترانزاكشن موازية؛ أعد القراءة
    const raced = await tx.select().from(users).where(eq(users.telegramUserId, from.id)).limit(1);
    const row = raced[0];
    if (!row) {
      throw new Error("ensureCustomer: user row missing after insert conflict"); // §16.12: فشل صاخب
    }
    return row;
  });
}

/** تطبيع بسيط لرقم جهة الاتصال إلى E.164 — تيليغرام يرسله عادة بصيغة دولية بلا +. */
function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

async function removeConfirmButtons(ctx: Context, deps: CustomerFlowDeps): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup(); // بلا معامل = إزالة أزرار التأكيد من رسالة السعر
  } catch (error) {
    // §4.3: editMessage يرمي "message is not modified" وأشباهها — تجميلي هنا؛
    // معالجة صريحة بالتسجيل (§16.12) بلا إفشال التدفق: الطلب نفسه لا يتأثر.
    console.error(
      JSON.stringify({
        action: "edit_reply_markup_failed",
        tenantId: deps.tenantId,
        chatId: ctx.chat?.id ?? null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** يسجّل معالجات بوت الزبون: /start، التقاط الهاتف، اختيار الخدمة، الموقعان، التأكيد/الإلغاء. */
export function registerCustomerFlow(bot: Bot, deps: CustomerFlowDeps): void {
  // —— /start: ترحيب + إنشاء صف المستخدم + طلب الهاتف إن غاب (§3 v1.1) ——
  bot.command(
    "start",
    guard(deps, "start", async (ctx) => {
      if (!ctx.from || !ctx.chat) return; // لا مرسل معروف — لا شيء نفعله
      await clearConv(deps.redis, deps.tenantId, ctx.chat.id); // /start يصفّر أي تدفق عالق
      const user = await ensureCustomer(deps, ctx.from);
      const name = escapeHtml(ctx.from.first_name); // §4.3: "أحمد <b>" بيكسر الرسالة
      if (!user.phoneE164) {
        await ctx.reply(
          `أهلاً ${name} 👋\nحتى نقدر نوصّلك ونتواصل معك بسرعة، شارك رقم هاتفك بالزر تحت 👇`,
          { reply_markup: phoneKeyboard() },
        );
        return;
      }
      await ctx.reply(`أهلاً ${name} 👋\nشو منقدّم لك اليوم؟`, { reply_markup: mainMenuKeyboard() });
    }),
  );

  // —— التقاط الهاتف: contact handler يحفظ phone_e164 (§3 v1.1) ——
  bot.on(
    "message:contact",
    guard(deps, "contact", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      const contact = ctx.message.contact;
      // نقبل رقم صاحب المحادثة نفسه فقط — لا جهات اتصال الآخرين
      if (contact.user_id !== undefined && contact.user_id !== ctx.from.id) {
        await ctx.reply("رجاءً شارك رقمك أنت عبر زر «مشاركة رقم الهاتف» 🙏", { reply_markup: phoneKeyboard() });
        return;
      }
      const phone = normalizeE164(contact.phone_number);
      if (phone === null) {
        await ctx.reply("ما قدرنا نقرأ الرقم 😅 جرّب الزر مرة تانية:", { reply_markup: phoneKeyboard() });
        return;
      }
      const user = await ensureCustomer(deps, ctx.from);
      await withTenant(deps.db, deps.tenantId, (tx) =>
        tx.update(users).set({ phoneE164: phone, updatedAt: new Date() }).where(eq(users.id, user.id)),
      );
      await ctx.reply("تمام، انحفظ رقمك ✅ شو منقدّم لك؟", { reply_markup: mainMenuKeyboard() });
    }),
  );

  // —— اختيار الخدمة (نص زر القائمة): step=awaiting_pickup ثم awaiting_dropoff بالتسلسل ——
  bot.hears(
    [BTN_P2P, BTN_PARCEL],
    guard(deps, "select_service", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      const service: Extract<Service, "p2p" | "parcel"> = ctx.message?.text === BTN_PARCEL ? "parcel" : "p2p";
      const user = await ensureCustomer(deps, ctx.from);
      if (!user.phoneE164) {
        // COD بلا رقم تواصل = طلب غير قابل للتشغيل — نلتقط الهاتف أولاً (§3 v1.1)
        await ctx.reply("قبل أول طلب منحتاج رقمك للتواصل 📱👇", { reply_markup: phoneKeyboard() });
        return;
      }
      await saveConv(deps.redis, deps.tenantId, ctx.chat.id, { step: "awaiting_pickup", service });
      await ctx.reply("من وين منستلم؟ شارك موقع نقطة <b>الاستلام</b> بالزر تحت 📍", {
        reply_markup: locationKeyboard(),
      });
    }),
  );

  // —— استقبال المواقع: الاستلام أولاً ثم التسليم، وعند اكتمالهما التسعير + التأكيد ——
  // §4.3/الفخ 9: live location تصل كـ edited_message — فلتر "message:location" يستثنيها
  // قصداً؛ معالجتها (تتبع السائق) معالج منفصل بالمرحلة 2 ولا تدخل منطق المحادثة.
  bot.on(
    "message:location",
    guard(deps, "location", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      const conv = await loadConv(deps.redis, deps.tenantId, ctx.chat.id);
      const point = fromTelegram(ctx.message.location); // الفخ 6: تيليغرام (lat, lng) → Point مسمّى

      if (conv.step === "awaiting_pickup" && conv.service !== undefined) {
        await saveConv(deps.redis, deps.tenantId, ctx.chat.id, {
          step: "awaiting_dropoff",
          service: conv.service,
          pickup: { lat: point.lat, lng: point.lng },
        });
        await ctx.reply("وهلق لوين منوصّل؟ شارك موقع نقطة <b>التسليم</b> 📍", {
          reply_markup: locationKeyboard(),
        });
        return;
      }

      if (conv.step === "awaiting_dropoff" && conv.service !== undefined && conv.pickup !== undefined) {
        const pickup = makePoint(conv.pickup.lat, conv.pickup.lng);
        const quote = await quoteForTenant(deps.db, deps.tenantId, {
          service: conv.service,
          pickup,
          dropoff: point,
        });
        await saveConv(deps.redis, deps.tenantId, ctx.chat.id, {
          step: "awaiting_confirm",
          service: conv.service,
          pickup: conv.pickup,
          dropoff: { lat: point.lat, lng: point.lng },
          quoteTotal: quote.components.total.toString(), // D5: bigint → نص للمقارنة، لا للحساب
        });
        // §4.4 v1.1 إلزامي: السعر مفصّلاً + زر تأكيد صريح **قبل** إنشاء أي صف
        await ctx.reply(quoteCard({ components: quote.components, distanceM: quote.distanceM, currency: deps.currency }), {
          reply_markup: confirmKeyboard(),
        });
        return;
      }

      await ctx.reply("لنبلّش، اختار نوع الخدمة أولاً 👇", { reply_markup: mainMenuKeyboard() });
    }),
  );

  // —— ord:confirm: إنشاء الطلب بفاعل customer ثم بطاقة الطلب ——
  bot.callbackQuery(
    CB_CONFIRM,
    guard(deps, "order_confirm", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3: خلال ثوانٍ وإلا الزر بيضل يحمّل عند الزبون
      if (!ctx.from || !ctx.chat) return;
      const chatId = ctx.chat.id;

      const conv = await loadConv(deps.redis, deps.tenantId, chatId);
      if (conv.step !== "awaiting_confirm" || conv.service === undefined || conv.pickup === undefined || conv.dropoff === undefined) {
        // §4.4: TTL الحالة ساعة — الزر لا يحمل سياق طلبٍ لم يُنشأ بعد، فالعودة للبداية
        await removeConfirmButtons(ctx, deps);
        await ctx.reply("انتهت صلاحية هالعرض ⌛ ابدأ طلب جديد من القائمة 👇", { reply_markup: mainMenuKeyboard() });
        return;
      }

      // الفخ 7 — مطالبة ذرّية: ضغطتا تأكيد متسابقتان → واحدة فقط تكسب مسح الحالة وتنشئ الطلب
      const claimed = await clearConv(deps.redis, deps.tenantId, chatId);
      if (!claimed) return;

      const user = await ensureCustomer(deps, ctx.from);

      // §11 — حد المعدل: 5 طلبات/ساعة لكل مستخدم. رسالة مهذبة ولا إنشاء عند التجاوز.
      const orderCount = await bumpOrderRate(deps.redis, deps.tenantId, ctx.from.id);
      if (isOverLimit(orderCount)) {
        await ctx.reply("وصلت الحد الأقصى للطلبات هالساعة 🙏 جرّب بعد شوي أو تواصل مع المكتب.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      const { order } = await createOrder(deps.db, deps.tenantId, {
        service: conv.service,
        customerId: user.id,
        pickup: makePoint(conv.pickup.lat, conv.pickup.lng),
        dropoff: makePoint(conv.dropoff.lat, conv.dropoff.lng),
        createdBy: { type: "customer", id: user.id },
      });

      await removeConfirmButtons(ctx, deps);
      const sent = await ctx.reply(
        orderCard({
          publicCode: order.publicCode,
          status: order.status,
          priceTotal: order.priceTotal,
          currency: deps.currency,
        }),
        { reply_markup: mainMenuKeyboard() },
      );
      if (conv.quoteTotal !== undefined && order.priceTotal.toString() !== conv.quoteTotal) {
        // §4.4: لا سعر مفاجئ — نادر (تغيّرت قاعدة التسعير بين العرض والتأكيد)؛ نصارح الزبون
        await ctx.reply("ملاحظة: تحدّث السعر شوي عن المعروض قبل قليل — المعتمد هو اللي بالبطاقة أعلاه 👆");
      }

      // §3 customer_msg_id — رسالة البطاقة الحية عند الزبون: تحديث عمود عادي عبر withTenant؛
      // ليس status — لا يمسّ آلة الحالة (D8: كل تغيير حالة عبر transition حصراً).
      await withTenant(deps.db, deps.tenantId, (tx) =>
        tx.update(orders).set({ customerMsgId: sent.message_id, updatedAt: new Date() }).where(eq(orders.id, order.id)),
      );
    }),
  );

  // —— ord:cancel: مسح الحالة والعودة للقائمة ——
  bot.callbackQuery(
    CB_CANCEL,
    guard(deps, "order_cancel", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      if (!ctx.chat) return;
      await clearConv(deps.redis, deps.tenantId, ctx.chat.id);
      await removeConfirmButtons(ctx, deps);
      await ctx.reply("ولا يهمك، ما أنشأنا شي 👌 اختار من جديد وقت ما تحب:", { reply_markup: mainMenuKeyboard() });
    }),
  );
}
