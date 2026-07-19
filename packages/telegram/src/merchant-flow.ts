import {
  bindMerchantOperator,
  listCatalog,
  merchantAcceptOrder,
  merchantMarkReady,
  merchantRejectOrder,
  resolveMerchantOperator,
  toggleCatalogItemAvailability,
  type CatalogItemView,
  type Db,
} from "@quickdrop/db";
import { InlineKeyboard, type Bot, type Context, type NextFunction } from "grammy";
import type { ConvRedis } from "./conversation.js";
import { UUID_CAPTURE } from "./driver-logic.js";
import { escapeHtml } from "./html.js";

// §3 (بوت التاجر) — نفس بوت المستأجر للجميع، الفصل بالدور (صف merchant_operators).
// المشغّل يربط مطعمه مرة واحدة برابط عميق يولّده الداشبورد (start=mrc_<code>)، ثم تصله
// بطاقات الطلبات الجديدة بأزرار قبول (+ مدة تحضير) / رفض. القبول = علم merchant_confirmed_at
// (لا يمسّ آلة الحالة D8)؛ الرفض = إلغاء عبر transition() (D8). كل القرار بالقاعدة (D16).

// —— callback_data (§4.4: حد 64 بايت) ——
// القبول يحمل مدة التحضير: 'mo:acc:{orderId}:{min}' — 'mo:acc:'(7)+36+':'+≤3 = ≤47 بايت.
export const CB_MERCHANT_ACCEPT_PREFIX = "mo:acc";
export const CB_MERCHANT_REJECT_PREFIX = "mo:rej";

/** §3 — خيارات مدة التحضير المعروضة كأزرار قبول (دقائق). */
export const PREP_OPTIONS = [15, 30, 45] as const;

/** بادئة حمولة الرابط العميق للربط: start=mrc_<code> (code أبجدي-رقمي §11). */
export const BIND_PAYLOAD_RE = /^mrc_([A-Za-z0-9]{6,32})$/;

export function merchantAcceptCb(orderId: string, prepMinutes: number): string {
  const data = `${CB_MERCHANT_ACCEPT_PREFIX}:${orderId}:${prepMinutes}`;
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > 64) throw new RangeError(`callback_data exceeds 64 bytes (${bytes})`);
  return data;
}

export function merchantRejectCb(orderId: string): string {
  return `${CB_MERCHANT_REJECT_PREFIX}:${orderId}`;
}

// §3 — قلب توفّر صنف من بوت التاجر: 'mo:av:{itemId}'. المكتب يقلبه أيضاً من الداشبورد.
export const CB_MERCHANT_AVAIL_PREFIX = "mo:av";
export function merchantAvailCb(itemId: string): string {
  return `${CB_MERCHANT_AVAIL_PREFIX}:${itemId}`;
}

// §4.2 — جهوز المطبخ: 'mo:rdy:{orderId}' → transition(preparing→ready) — يشعل المفصل
export const CB_MERCHANT_READY_PREFIX = "mo:rdy";
export function merchantReadyCb(orderId: string): string {
  return `${CB_MERCHANT_READY_PREFIX}:${orderId}`;
}

export const MERCHANT_ACCEPT_RE = new RegExp(`^${CB_MERCHANT_ACCEPT_PREFIX}:${UUID_CAPTURE}:(\\d{1,3})$`);
export const MERCHANT_REJECT_RE = new RegExp(`^${CB_MERCHANT_REJECT_PREFIX}:${UUID_CAPTURE}$`);
export const MERCHANT_AVAIL_RE = new RegExp(`^${CB_MERCHANT_AVAIL_PREFIX}:${UUID_CAPTURE}$`);
export const MERCHANT_READY_RE = new RegExp(`^${CB_MERCHANT_READY_PREFIX}:${UUID_CAPTURE}$`);

/** §4.2 — لوحة «الطلب جاهز» على بطاقة القبول: المطبخ يعلن الجهوز فيصدر المفصل. */
export function merchantReadyKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard().text("🛎 الطلب جاهز", merchantReadyCb(orderId));
}

/** §3 — أقصى أصناف تُعرض بلوحة قلب التوفّر (حد أزرار تيليغرام العملي). */
const MENU_TOGGLE_LIMIT = 40;

/** لوحة قلب توفّر أصناف المطعم: زر لكل صنف باسمه وحالته، تُبنى من صفوف القاعدة. */
export function merchantMenuKeyboard(items: CatalogItemView[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const it of items.slice(0, MENU_TOGGLE_LIMIT)) {
    kb.text(`${it.isAvailable ? "✅" : "❌"} ${it.nameAr}`, merchantAvailCb(it.id)).row();
  }
  return kb;
}

/** مفتاح Redis لكود الربط — يولّده الـ api (مطعم) ويقرؤه البوت (نفس Redis). */
export function merchantBindKey(tenantId: string, code: string): string {
  return `mbind:${tenantId}:${code}`;
}

/** عمر كود الربط (§3) — 15 دقيقة تكفي المشغّل لفتح الرابط، وقصير يحدّ نافذة التسريب. */
export const MERCHANT_BIND_TTL_SECONDS = 900;

/** حمولة الرابط العميق: t.me/<bot>?start=mrc_<code>. */
export function merchantBindPayload(code: string): string {
  return `mrc_${code}`;
}

/** لوحة أزرار بطاقة الطلب للتاجر: صف قبول لكل مدة تحضير + صف رفض. تُستهلك من مُبلِّغ الإشعارات. */
export function merchantOrderKeyboard(orderId: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const min of PREP_OPTIONS) kb.text(`✅ قبول ⏱${min}د`, merchantAcceptCb(orderId, min));
  kb.row().text("❌ رفض", merchantRejectCb(orderId));
  return kb;
}

export interface MerchantFlowDeps {
  db: Db;
  tenantId: string;
  /** §3 — كود الربط قصير العمر بـ Redis (get/del). نفس عميل حالة المحادثة. */
  redis: ConvRedis;
}

const GENERIC_ERROR_AR = "عذراً، صار عندنا خطأ مؤقت 🙏 جرّب مرة تانية بعد شوي.";

/** §11/§16.12 — نفس عقد guard بتدفقات البوت: رسالة عربية عامة، التفاصيل باللوغ، لا إعادة رمي. */
function guard<C extends Context>(
  deps: MerchantFlowDeps,
  action: string,
  handler: (ctx: C, next: NextFunction) => Promise<void>,
): (ctx: C, next: NextFunction) => Promise<void> {
  return async (ctx, next) => {
    try {
      await handler(ctx, next);
    } catch (error) {
      console.error(
        JSON.stringify({
          action: "merchant_flow_error",
          flow: action,
          tenantId: deps.tenantId,
          updateId: ctx.update.update_id,
          chatId: ctx.chat?.id ?? null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
      try {
        await ctx.reply(GENERIC_ERROR_AR);
      } catch {
        // المستخدم حظر البوت (403) أو الشبكة ساقطة — الخطأ الأصلي مسجَّل أعلاه
      }
    }
  };
}

/** §4.3 — تعديل البطاقة (إزالة الأزرار أو استبدالها بلوحة)؛ «not modified» تُتجاهل، وأي فشل آخر → رسالة جديدة. */
async function editCardText(ctx: Context, deps: MerchantFlowDeps, text: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("message is not modified")) return;
    console.error(
      JSON.stringify({ action: "merchant_card_edit_failed", tenantId: deps.tenantId, chatId: ctx.chat?.id ?? null, error: message }),
    );
    try {
      await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
    } catch {
      // 403 أو شبكة — مسجَّل أعلاه
    }
  }
}

/**
 * يسجّل معالجات بوت التاجر. **يُسجَّل قبل registerCustomerFlow**: معالج /start هنا يمرّر
 * next() لأي حمولة ليست كود ربط، فيصل /start العادي لتدفق الزبون بلا تعطيل.
 */
export function registerMerchantFlow(bot: Bot, deps: MerchantFlowDeps): void {
  // —— /start mrc_<code> — ربط حساب تيليغرام بمطعم (رابط عميق من الداشبورد) ——
  bot.command(
    "start",
    guard(deps, "bind", async (ctx, next) => {
      const payload = typeof ctx.match === "string" ? ctx.match : "";
      const m = BIND_PAYLOAD_RE.exec(payload);
      if (!m || !ctx.from) {
        await next(); // ليست حمولة ربط → /start العادي لتدفق الزبون
        return;
      }
      const code = m[1]!;
      const merchantId = await deps.redis.get(merchantBindKey(deps.tenantId, code));
      if (merchantId === null) {
        await ctx.reply("كود الربط غير صالح أو منتهي ⌛ اطلب رابطاً جديداً من المكتب.");
        return;
      }
      const bound = await bindMerchantOperator(deps.db, deps.tenantId, merchantId, ctx.from.id);
      if (!bound) {
        await ctx.reply("تعذّر الربط — المطعم غير موجود 🤔 تواصل مع المكتب.");
        return;
      }
      await deps.redis.del(merchantBindKey(deps.tenantId, code)); // كود لمرة واحدة
      await ctx.reply(
        `تم ربط مطعم «${escapeHtml(bound.merchantName)}» ✅\nرح توصلك الطلبات الجديدة هون — تقبلها وتحدد مدة التحضير أو ترفضها.`,
      );
    }),
  );

  // —— mo:acc:{orderId}:{min} — قبول الطلب + مدة التحضير ——
  bot.callbackQuery(
    MERCHANT_ACCEPT_RE,
    guard(deps, "accept", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      const orderId = ctx.match?.[1];
      const minRaw = ctx.match?.[2];
      if (orderId === undefined || minRaw === undefined || !ctx.from) return;
      const prepMinutes = Number.parseInt(minRaw, 10);

      const result = await merchantAcceptOrder(deps.db, deps.tenantId, ctx.from.id, orderId, prepMinutes);
      switch (result.outcome) {
        case "accepted":
          // §4.2 D-M6: القبول = transition(→preparing)؛ البطاقة تعرض زر «الطلب جاهز»
          // (preparing→ready يشعل المفصل order.ready_for_dispatch بالمُطلِق الافتراضي)
          await editCardText(
            ctx,
            deps,
            `✅ قبلت الطلب #${escapeHtml(result.publicCode)} — مدة التحضير ⏱${prepMinutes} دقيقة.\nلما يجهز اضغط «الطلب جاهز» ليتحرك التوصيل.`,
            merchantReadyKeyboard(orderId),
          );
          return;
        case "already":
          await ctx.reply("هذا الطلب بالمطبخ سلفاً ✋");
          return;
        case "too_late":
          await ctx.reply("الطلب لم يعد قابلاً للقبول (أُلغي أو تجاوز المرحلة) ⏳");
          return;
        case "wrong_merchant":
          await ctx.reply("هذا الطلب ليس لمطعمك 🤷");
          return;
        case "not_operator":
          await ctx.reply("لم يعد لديك صلاحية على مطعم 🚫 تواصل مع المكتب.");
          return;
        case "not_found":
          await editCardText(ctx, deps, "الطلب لم يعد متاحاً 🤷");
          return;
      }
    }),
  );

  // —— mo:rdy:{orderId} — المطبخ جهّز الطلب (preparing→ready → يشعل المفصل) ——
  bot.callbackQuery(
    MERCHANT_READY_RE,
    guard(deps, "ready", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      const orderId = ctx.match?.[1];
      if (orderId === undefined || !ctx.from) return;

      const result = await merchantMarkReady(deps.db, deps.tenantId, ctx.from.id, orderId);
      switch (result.outcome) {
        case "ready":
          await editCardText(ctx, deps, `🛎 الطلب #${escapeHtml(result.publicCode)} جاهز — جاري إرسال سائق.`);
          return;
        case "already":
          await ctx.reply("الطلب معلَّم جاهزاً سلفاً ✋");
          return;
        case "too_late":
          await ctx.reply("الطلب لم يعد بالمطبخ (أُلغي أو تجاوز المرحلة) ⏳");
          return;
        case "wrong_merchant":
          await ctx.reply("هذا الطلب ليس لمطعمك 🤷");
          return;
        case "not_operator":
          await ctx.reply("لم يعد لديك صلاحية على مطعم 🚫 تواصل مع المكتب.");
          return;
        case "not_found":
          await editCardText(ctx, deps, "الطلب لم يعد متاحاً 🤷");
          return;
      }
    }),
  );

  // —— mo:rej:{orderId} — رفض الطلب (إلغاء) ——
  bot.callbackQuery(
    MERCHANT_REJECT_RE,
    guard(deps, "reject", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      const orderId = ctx.match?.[1];
      if (orderId === undefined || !ctx.from) return;

      const result = await merchantRejectOrder(deps.db, deps.tenantId, ctx.from.id, orderId);
      switch (result.outcome) {
        case "rejected":
          await editCardText(ctx, deps, `❌ رفضت الطلب #${escapeHtml(result.publicCode)} — تم إلغاؤه.`);
          return;
        case "too_late":
          await ctx.reply("الطلب صار قيد التوصيل ⏳ تواصل مع المكتب.");
          return;
        case "wrong_merchant":
          await ctx.reply("هذا الطلب ليس لمطعمك 🤷");
          return;
        case "not_operator":
          await ctx.reply("لم يعد لديك صلاحية على مطعم 🚫 تواصل مع المكتب.");
          return;
        case "not_found":
          await editCardText(ctx, deps, "الطلب لم يعد متاحاً 🤷");
          return;
      }
    }),
  );

  // —— /menu — عرض أصناف المطعم مع أزرار قلب التوفّر (§3: التاجر يعلّم "نفد" من بوته) ——
  bot.command(
    "menu",
    guard(deps, "menu", async (ctx) => {
      if (!ctx.from) return;
      const op = await resolveMerchantOperator(deps.db, deps.tenantId, ctx.from.id);
      if (!op) {
        await ctx.reply("هذا الأمر لمشغّلي المطاعم فقط 🚫");
        return;
      }
      const items = await listCatalog(deps.db, deps.tenantId, op.merchantId);
      if (items.length === 0) {
        await ctx.reply(`لا أصناف بكتالوج «${escapeHtml(op.merchantName)}» بعد — يضيفها المكتب من الداشبورد.`);
        return;
      }
      await ctx.reply(`أصناف «${escapeHtml(op.merchantName)}» — اضغط الصنف لقلب توفّره:`, {
        reply_markup: merchantMenuKeyboard(items),
      });
    }),
  );

  // —— mo:av:{itemId} — قلب توفّر صنف، ثم إعادة بناء اللوحة من صفوف القاعدة (D16) ——
  bot.callbackQuery(
    MERCHANT_AVAIL_RE,
    guard(deps, "toggle_avail", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      const itemId = ctx.match?.[1];
      if (itemId === undefined || !ctx.from) return;

      const result = await toggleCatalogItemAvailability(deps.db, deps.tenantId, ctx.from.id, itemId);
      if (!result) {
        // ليس مشغّلاً، أو الصنف ليس لمطعمه (عزل داخل المستأجر)
        await ctx.reply("تعذّر تعديل الصنف 🤷 (ليس لمطعمك أو لم يعد لديك صلاحية).");
        return;
      }
      // أعد بناء اللوحة من القاعدة كي تعكس الحالة الجديدة لكل الأصناف (لا من الذاكرة)
      const op = await resolveMerchantOperator(deps.db, deps.tenantId, ctx.from.id);
      if (op) {
        const items = await listCatalog(deps.db, deps.tenantId, op.merchantId);
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: merchantMenuKeyboard(items) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("message is not modified")) {
            console.error(
              JSON.stringify({ action: "merchant_menu_edit_failed", tenantId: deps.tenantId, error: message }),
            );
          }
        }
      }
      await ctx.reply(`${result.isAvailable ? "✅ صار متوفّراً" : "❌ صار غير متوفّر"}: ${escapeHtml(result.nameAr)}`);
    }),
  );
}
