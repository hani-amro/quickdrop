import { appendInboundMessage, catalogItems, createOrder, merchants, orders, quoteForTenant, users, withTenant, type Db, type User } from "@quickdrop/db";
import { bumpOrderRate, bumpSupportRate, isOverLimit, SUPPORT_MSG_LIMIT_PER_MINUTE } from "./rate-limit.js";
import { formatMoney, fromTelegram, makePoint, type Service } from "@quickdrop/shared";
import { and, eq, sql } from "drizzle-orm";
import { InlineKeyboard, Keyboard, type Bot, type Context } from "grammy";
import { clearConv, loadConv, saveConv, type CartLine, type ConvRedis } from "./conversation.js";
import {
  addToCart,
  CB_FOOD_CHECKOUT,
  CB_FOOD_CONFIRM,
  ITEM_CB_RE,
  itemCb,
  MERCHANT_CB_RE,
  merchantCb,
} from "./food.js";
import { escapeHtml, foodConfirmCard, foodMenuCard, orderCard, quoteCard, type FoodDisplayLine } from "./html.js";

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
export const BTN_FOOD = "🍔 طلب طعام"; // §3 — يبدأ تدفق الطعام الفرعي
export const BTN_SUPPORT = "🆘 الدعم"; // §9 — يبدأ وضع مراسلة المكتب

// callback_data قصيرة (§4.4: حد 64 بايت — معرّفات قصيرة، لا JSON)
export const CB_CONFIRM = "ord:confirm";
export const CB_CANCEL = "ord:cancel";

const GENERIC_ERROR_AR = "عذراً، صار عندنا خطأ مؤقت 🙏 جرّب مرة تانية بعد شوي.";

// §3 — سقوف عرض معقولة لأزرار inline (تيليغرام يحدّ عدد الأزرار عملياً)
const MERCHANT_LIST_LIMIT = 30;
const MENU_ITEM_LIMIT = 40;

// §9 — سقف طول رسالة الدعم الواحدة (نصوص تيليغرام ≤ 4096؛ نقصّها احتياطاً لـ 2000)
const SUPPORT_MSG_MAX = 2000;

function mainMenuKeyboard(): Keyboard {
  return new Keyboard().text(BTN_P2P).text(BTN_PARCEL).row().text(BTN_FOOD).text(BTN_SUPPORT).resized();
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

// —— §3 مساعدات تدفق الطعام: قراءة المطاعم/الكتالوج مباشرة عبر withTenant (RLS §2.2) ——

/** مطاعم المستأجر الفعّالة (category='restaurant') أزراراً. eq(tenantId) متسق مع resolveFoodOrder. */
async function listActiveRestaurants(deps: CustomerFlowDeps): Promise<{ id: string; name: string }[]> {
  return withTenant(deps.db, deps.tenantId, (tx) =>
    tx
      .select({ id: merchants.id, name: merchants.name })
      .from(merchants)
      .where(
        and(eq(merchants.tenantId, deps.tenantId), eq(merchants.category, "restaurant"), eq(merchants.isActive, true)),
      )
      .orderBy(merchants.name)
      .limit(MERCHANT_LIST_LIMIT),
  );
}

interface MenuView {
  name: string;
  /** موقع المطعم = نقطة الاستلام (createOrder يشتقها؛ نخزّنها لتمريرها كـ pickup المطلوب بالنوع). */
  pickup: { lat: number; lng: number };
  items: { id: string; nameAr: string; price: bigint }[];
}

/** §3 — المطعم (اسم + نقطة الاستلام) وأصنافه المتاحة (مرتّبة sort_order) بترانزاكشن واحدة. */
async function loadMenuView(deps: CustomerFlowDeps, merchantId: string): Promise<MenuView | null> {
  return withTenant(deps.db, deps.tenantId, async (tx) => {
    const mRows = await tx
      .select({
        name: merchants.name,
        // D7: ST_Y/ST_X على geography عبر geometry cast (كما في resolveFoodOrder)
        lat: sql<number>`ST_Y(${merchants.point}::geometry)`,
        lng: sql<number>`ST_X(${merchants.point}::geometry)`,
      })
      .from(merchants)
      .where(and(eq(merchants.tenantId, deps.tenantId), eq(merchants.id, merchantId), eq(merchants.isActive, true)))
      .limit(1);
    const m = mRows[0];
    if (!m) return null;
    const items = await tx
      .select({ id: catalogItems.id, nameAr: catalogItems.nameAr, price: catalogItems.price })
      .from(catalogItems)
      .where(
        and(
          eq(catalogItems.tenantId, deps.tenantId),
          eq(catalogItems.merchantId, merchantId),
          eq(catalogItems.isAvailable, true),
        ),
      )
      .orderBy(catalogItems.sortOrder)
      .limit(MENU_ITEM_LIMIT);
    return { name: m.name, pickup: { lat: m.lat, lng: m.lng }, items };
  });
}

/** أزرار اختيار المطعم (inline) — callback 'm:{merchantId}' (§4.4 ≤64 بايت). */
function merchantsKeyboard(rows: { id: string; name: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of rows) kb.text(m.name, merchantCb(m.id)).row();
  return kb;
}

/** أزرار المنيو: كل صنف زر «➕ الاسم — السعر» (callback 'ci:{itemId}') + تم/إلغاء. */
function foodMenuKeyboard(items: MenuView["items"], currency: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  // نص الأزرار عادي (بلا parse_mode) — لا يحتاج escapeHtml؛ formatMoney للعرض (D5)
  for (const it of items) kb.text(`➕ ${it.nameAr} — ${formatMoney(it.price, "ar-SY", currency)}`, itemCb(it.id)).row();
  kb.text("🛒 تم، حدد التوصيل", CB_FOOD_CHECKOUT).row();
  kb.text("❌ إلغاء", CB_CANCEL);
  return kb;
}

function foodConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ تأكيد الطلب", CB_FOOD_CONFIRM).text("❌ إلغاء", CB_CANCEL);
}

/** يربط أسطر السلة بأصناف المنيو (اسم + سعر لقطة) للعرض؛ صنف اختفى يُسقَط بهدوء. */
function buildDisplayLines(cart: CartLine[], items: MenuView["items"]): FoodDisplayLine[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: FoodDisplayLine[] = [];
  for (const line of cart) {
    const it = byId.get(line.catalogItemId);
    if (it) lines.push({ nameAr: it.nameAr, qty: line.qty, unitPrice: it.price });
  }
  return lines;
}

/** يحدّث رسالة المنيو نفسها (نص + أزرار) بعد كل إضافة — أخطاء التعديل تجميلية (§4.3). */
async function editFoodMenu(ctx: Context, deps: CustomerFlowDeps, view: MenuView, lines: FoodDisplayLine[]): Promise<void> {
  try {
    await ctx.editMessageText(foodMenuCard({ merchantName: view.name, lines, currency: deps.currency }), {
      reply_markup: foodMenuKeyboard(view.items, deps.currency),
    });
  } catch (error) {
    // §4.3: "message is not modified" وأشباهها (ضغطة على صنف زائل لا تغيّر النص) — نسجّل بلا إفشال
    console.error(
      JSON.stringify({
        action: "food_menu_edit_failed",
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
      // نقبل رقم صاحب المحادثة نفسه فقط عبر زر request_contact. الرقم بلا user_id (بطاقة
      // جهة اتصال يدوية لرقم غير مسجّل بتيليغرام) قد يكون رقم ضحية — نرفضه (§11): غياب
      // user_id = رفض، لا قبول. سابقاً كان الشرط يتخطّى الرفض عند undefined فيُحفَظ رقم أي أحد.
      if (contact.user_id === undefined || contact.user_id !== ctx.from.id) {
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

  // —— 🍔 طلب طعام: يبدأ تدفق الطعام بقائمة المطاعم الفعّالة (§3) ——
  bot.hears(
    BTN_FOOD,
    guard(deps, "food_start", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      const user = await ensureCustomer(deps, ctx.from);
      if (!user.phoneE164) {
        // COD بلا رقم تواصل = طلب غير قابل للتشغيل — نلتقط الهاتف أولاً (§3 v1.1)
        await ctx.reply("قبل أول طلب منحتاج رقمك للتواصل 📱👇", { reply_markup: phoneKeyboard() });
        return;
      }
      const restaurants = await listActiveRestaurants(deps);
      if (restaurants.length === 0) {
        await ctx.reply("ما في مطاعم متاحة حالياً 🙏 جرّب بعد شوي.", { reply_markup: mainMenuKeyboard() });
        return;
      }
      await saveConv(deps.redis, deps.tenantId, ctx.chat.id, { step: "food_pick_merchant", service: "food" });
      await ctx.reply("اختار المطعم 🍽", { reply_markup: merchantsKeyboard(restaurants) });
    }),
  );

  // —— 🆘 الدعم: يدخل وضع المراسلة (step=support) — كل نص لاحق يُلحَق بخيط الزبون (§9) ——
  bot.hears(
    BTN_SUPPORT,
    guard(deps, "support_start", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      // الدعم متاح بلا رقم هاتف (مراسلة نصية بحتة) — ننشئ صف المستخدم فقط
      await ensureCustomer(deps, ctx.from);
      await saveConv(deps.redis, deps.tenantId, ctx.chat.id, { step: "support" });
      await ctx.reply("اكتب رسالتك للمكتب وبنرد عليك بأسرع وقت 👇 (اضغط /start للرجوع للقائمة)");
    }),
  );

  // —— m:{merchantId} — عرض منيو المطعم وأصنافه المتاحة، والسلة تبدأ فارغة (§3) ——
  bot.callbackQuery(
    MERCHANT_CB_RE,
    guard(deps, "food_pick_merchant", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3: خلال ثوانٍ وإلا الزر بيضل يحمّل
      if (!ctx.chat) return;
      const merchantId = ctx.match?.[1];
      if (merchantId === undefined) return;
      const view = await loadMenuView(deps, merchantId);
      if (!view) {
        await ctx.reply("المطعم ما عاد متاح 😕 اختار من جديد:", { reply_markup: mainMenuKeyboard() });
        return;
      }
      if (view.items.length === 0) {
        await ctx.reply(`«${escapeHtml(view.name)}» ما عنده أصناف متاحة حالياً 🙏 جرّب مطعم تاني.`, {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }
      // نقطة الاستلام (موقع المطعم) تُخزَّن لتُمرَّر كـ pickup المطلوب بالنوع؛ createOrder يشتقها أيضاً
      await saveConv(deps.redis, deps.tenantId, ctx.chat.id, {
        step: "food_menu",
        service: "food",
        merchantId,
        pickup: view.pickup,
        cart: [],
      });
      await ctx.reply(foodMenuCard({ merchantName: view.name, lines: [], currency: deps.currency }), {
        reply_markup: foodMenuKeyboard(view.items, deps.currency),
      });
    }),
  );

  // —— ci:{itemId} — إضافة صنف واحد للسلة وتحديث بطاقة المنيو بمكانها (§3) ——
  bot.callbackQuery(
    ITEM_CB_RE,
    guard(deps, "food_add_item", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      if (!ctx.chat) return;
      const itemId = ctx.match?.[1];
      if (itemId === undefined) return;
      const conv = await loadConv(deps.redis, deps.tenantId, ctx.chat.id);
      if (conv.step !== "food_menu" || conv.merchantId === undefined) {
        await ctx.reply("انتهت صلاحية القائمة ⌛ ابدأ طلب طعام جديد 👇", { reply_markup: mainMenuKeyboard() });
        return;
      }
      const view = await loadMenuView(deps, conv.merchantId);
      if (!view || view.items.length === 0) {
        await ctx.reply("المطعم ما عاد متاح 😕 اختار من جديد:", { reply_markup: mainMenuKeyboard() });
        return;
      }
      // صنف غير موجود بالمنيو الحالي (زر قديم بعد إخفاء الصنف) → لا نضيف، لكن نعيد رسم المنيو المحدّث
      const valid = view.items.some((i) => i.id === itemId);
      const cart = valid ? addToCart(conv.cart ?? [], itemId) : (conv.cart ?? []);
      await saveConv(deps.redis, deps.tenantId, ctx.chat.id, {
        step: "food_menu",
        service: "food",
        merchantId: conv.merchantId,
        ...(conv.pickup !== undefined ? { pickup: conv.pickup } : {}),
        cart,
      });
      await editFoodMenu(ctx, deps, view, buildDisplayLines(cart, view.items));
    }),
  );

  // —— food:checkout — الانتقال لطلب موقع التسليم (السلة يجب أن تكون غير فارغة) (§3) ——
  bot.callbackQuery(
    CB_FOOD_CHECKOUT,
    guard(deps, "food_checkout", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      if (!ctx.chat) return;
      const conv = await loadConv(deps.redis, deps.tenantId, ctx.chat.id);
      if (conv.step !== "food_menu" || conv.merchantId === undefined || conv.cart === undefined || conv.cart.length === 0) {
        await ctx.reply("سلتك فاضية 🛒 أضف صنف من الأزرار فوق 👆");
        return;
      }
      await saveConv(deps.redis, deps.tenantId, ctx.chat.id, {
        step: "food_dropoff",
        service: "food",
        merchantId: conv.merchantId,
        ...(conv.pickup !== undefined ? { pickup: conv.pickup } : {}),
        cart: conv.cart,
      });
      await removeConfirmButtons(ctx, deps); // إزالة أزرار المنيو من الرسالة القديمة
      await ctx.reply("تمام 👌 لوين منوصّل الطلب؟ شارك موقع <b>التسليم</b> 📍", { reply_markup: locationKeyboard() });
    }),
  );

  // —— food:confirm — إنشاء طلب الطعام بفاعل customer ثم بطاقة الطلب (§3) ——
  bot.callbackQuery(
    CB_FOOD_CONFIRM,
    guard(deps, "food_confirm", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      if (!ctx.from || !ctx.chat) return;
      const chatId = ctx.chat.id;

      const conv = await loadConv(deps.redis, deps.tenantId, chatId);
      if (
        conv.step !== "food_confirm" ||
        conv.merchantId === undefined ||
        conv.cart === undefined ||
        conv.cart.length === 0 ||
        conv.dropoff === undefined ||
        conv.pickup === undefined
      ) {
        await removeConfirmButtons(ctx, deps);
        await ctx.reply("انتهت صلاحية هالطلب ⌛ ابدأ طلب طعام جديد من القائمة 👇", { reply_markup: mainMenuKeyboard() });
        return;
      }

      // الفخ 7 — مطالبة ذرّية: ضغطتا تأكيد متسابقتان → واحدة فقط تكسب مسح الحالة وتنشئ الطلب
      const claimed = await clearConv(deps.redis, deps.tenantId, chatId);
      if (!claimed) return;

      const user = await ensureCustomer(deps, ctx.from);

      // §11 — حد المعدل: 5 طلبات/ساعة لكل مستخدم (نفس مسار p2p)
      const orderCount = await bumpOrderRate(deps.redis, deps.tenantId, ctx.from.id);
      if (isOverLimit(orderCount)) {
        await ctx.reply("وصلت الحد الأقصى للطلبات هالساعة 🙏 جرّب بعد شوي أو تواصل مع المكتب.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      // §3 — createOrder يشتق نقطة الاستلام والأسعار من المطعم/الكتالوج (goods_amount محسوب)؛
      // pickup المُمرَّر (موقع المطعم المخزَّن) مطلوب بالنوع لكن مُتجاهَل للطعام داخل createOrder.
      const { order } = await createOrder(deps.db, deps.tenantId, {
        service: "food",
        customerId: user.id,
        merchantId: conv.merchantId,
        items: conv.cart,
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

      // §3 customer_msg_id — رسالة البطاقة الحية عند الزبون (عمود عادي، لا يمسّ آلة الحالة D8)
      await withTenant(deps.db, deps.tenantId, (tx) =>
        tx.update(orders).set({ customerMsgId: sent.message_id, updatedAt: new Date() }).where(eq(orders.id, order.id)),
      );
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

      // §3 — الطعام: نقطة الاستلام هي المطعم (تُشتق بالإنشاء)، فهذا الموقع هو التسليم
      if (
        conv.step === "food_dropoff" &&
        conv.merchantId !== undefined &&
        conv.cart !== undefined &&
        conv.cart.length > 0
      ) {
        const view = await loadMenuView(deps, conv.merchantId);
        const lines = view ? buildDisplayLines(conv.cart, view.items) : [];
        if (!view || lines.length === 0) {
          // المطعم أُوقف أو كل أصنافه اختفت بين المنيو والتسليم — نبدأ من جديد بهدوء
          await clearConv(deps.redis, deps.tenantId, ctx.chat.id);
          await ctx.reply("صار في تغيير بالمطعم أو الأصناف 😕 ابدأ طلب طعام جديد 👇", {
            reply_markup: mainMenuKeyboard(),
          });
          return;
        }
        await saveConv(deps.redis, deps.tenantId, ctx.chat.id, {
          step: "food_confirm",
          service: "food",
          merchantId: conv.merchantId,
          ...(conv.pickup !== undefined ? { pickup: conv.pickup } : {}),
          dropoff: { lat: point.lat, lng: point.lng },
          cart: conv.cart,
        });
        // §4.4 إلزامي: تفصيل + تأكيد صريح قبل إنشاء أي صف (أجرة التوصيل تُحسب عند التأكيد)
        await ctx.reply(foodConfirmCard({ merchantName: view.name, lines, currency: deps.currency }), {
          reply_markup: foodConfirmKeyboard(),
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

  // —— §9 رسالة الدعم: **آخر** معالج نصي كي تُطابَق أزرار القائمة والأوامر أولاً (bot.hears/
  // bot.command أعلاه لا تستدعي next). خارج وضع الدعم لا نتدخّل بأي تدفق آخر — رجوع صامت. ——
  bot.on(
    "message:text",
    guard(deps, "support_msg", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;
      const conv = await loadConv(deps.redis, deps.tenantId, ctx.chat.id);
      if (conv.step !== "support") return; // ليس بوضع الدعم — لا شيء (لا يمسّ أي تدفق آخر)

      const text = ctx.message.text.trim();
      if (text.length === 0) {
        await ctx.reply("اكتب رسالتك النصية للمكتب 🙏");
        return; // نبقى بوضع الدعم
      }
      // §11 — حد الإغراق: رسائل الدعم الواردة لكل مستخدم/دقيقة (يحمي جداول الدعم/الـ inbox)
      const supportCount = await bumpSupportRate(deps.redis, deps.tenantId, ctx.from.id);
      if (isOverLimit(supportCount, SUPPORT_MSG_LIMIT_PER_MINUTE)) {
        await ctx.reply("وصلنا كثير رسائل بسرعة 🙏 نظّم رسالتك وابعتها بعد دقيقة.");
        return; // نبقى بوضع الدعم
      }
      // نقصّ الطويل احتياطاً (Telegram ≤ 4096؛ نحدّ 2000 لخيط دعم مرتّب)
      const clipped = text.length > SUPPORT_MSG_MAX ? text.slice(0, SUPPORT_MSG_MAX) : text;

      const user = await ensureCustomer(deps, ctx.from);
      await appendInboundMessage(deps.db, deps.tenantId, user.id, clipped, ctx.message.message_id);
      await ctx.reply("وصلت رسالتك للمكتب ✅ رح نرد عليك قريباً."); // نبقى بوضع الدعم
    }),
  );
}
