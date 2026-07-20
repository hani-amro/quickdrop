import {
  drivers,
  InvalidTransitionError,
  orders,
  setDriverShift,
  tenants,
  transition,
  users,
  withTenant,
  type AcceptResult,
  type Db,
  type Tx,
} from "@quickdrop/db";
import { fromTelegram, type DriverStatus, type OrderStatus } from "@quickdrop/shared";
import { eq } from "drizzle-orm";
import { Keyboard, type Bot, type Context, type InlineKeyboard, type NextFunction } from "grammy";
import {
  CB_ORDER_ARRIVE_PREFIX,
  CB_ORDER_DELIVER_PREFIX,
  CB_ORDER_GO_PREFIX,
  CB_ORDER_PICKUP_PREFIX,
  CB_OFFER_ACCEPT_PREFIX,
  CB_OFFER_REJECT_PREFIX,
  taskKeyboard,
  UUID_CAPTURE,
} from "./driver-logic.js";
import { escapeHtml, taskCard } from "./html.js";

// §4.3/§6/§7 — بوت السائق. v1: **نفس بوت المستأجر للجميع** والفصل بالدور (صف drivers) —
// بوت السائق المستقل امتداد لقرار D3 (بوت لكل مستأجر) مؤجل لمرحلة لاحقة معلنة؛
// كل معالجات السائق تبدأ بـ resolveDriver: غير سائق → تجاهل بصمت (أو next() لتدفق الزبون).
//
// D16: كل رسالة قبول/رفض هنا تُشتق من AcceptResult القادم من ترانزاكشن القاعدة
// (dispatch.acceptOffer) — لا من وجود/غياب مفتاح Redis ولا من أي حالة بالذاكرة.

export interface DriverFlowDeps {
  db: Db;
  tenantId: string;
  /** §6.2 D16 — القبول قرار قاعدة حصراً: التنفيذ dispatch.acceptOffer (packages/db). */
  acceptOffer(offerId: string, driverId: string): Promise<AcceptResult>;
  /** §6.2 — الرفض يكتب صف العرض rejected بالقاعدة (dispatch.rejectOffer). */
  rejectOffer(offerId: string, driverId: string): Promise<void>;
  /** §7 — كل نقطة موقع (live أو عادية): INSERT driver_locations + فحص is_suspect عند الإدخال. */
  onLocation(driverId: string, point: { lat: number; lng: number }, recordedAt: Date): Promise<void>;
  /**
   * §11 — إثبات التسليم بالصورة: السائق يرسل صورة لطلبه النشط → إعادة ترميز (sharp،
   * يقتل payload + يمسح EXIF) وتخزين S3، وINSERT order_attachments. المنفّذ بالـ worker
   * (يملك القاعدة + عميل التخزين). غيابه (undefined) = POD معطّل (بلا S3 مُهيّأ).
   * يرجع نتيجة يُشتق منها الرد (لا active order / صيغة مرفوضة / نجاح).
   */
  onPodPhoto?: (driverId: string, imageBuffer: Buffer) => Promise<PodPhotoResult>;
}

export type PodPhotoResult =
  | { outcome: "stored"; publicCode: string }
  | { outcome: "no_active_order" }
  | { outcome: "rejected"; reason: string };

// —— نصوص أزرار الوردية (reply keyboard) — ثابتة كي يطابقها bot.hears حرفياً ——
export const BTN_SHIFT_START = "🟢 ابدأ وردية";
export const BTN_SHIFT_END = "🔴 أنهِ وردية";
/** «/شفت» ليس أمر تيليغرام صالحاً (الأوامر لاتينية فقط) — يُلتقط نصاً بـ bot.hears. */
export const CMD_SHIFT_AR = "/شفت";

// أنماط أزرار العروض — البناء المقابل بـ driver-logic.ts (offerAcceptCb/offerRejectCb)
const OFFER_ACCEPT_RE = new RegExp(`^${CB_OFFER_ACCEPT_PREFIX}:${UUID_CAPTURE}$`);
const OFFER_REJECT_RE = new RegExp(`^${CB_OFFER_REJECT_PREFIX}:${UUID_CAPTURE}$`);

function shiftKeyboard(status: DriverStatus): Keyboard {
  return new Keyboard().text(status === "online" ? BTN_SHIFT_END : BTN_SHIFT_START).resized();
}

// —— داخليات المعالجات ——

const GENERIC_ERROR_AR = "عذراً، صار عندنا خطأ مؤقت 🙏 جرّب مرة تانية بعد شوي.";
const NOT_NOW_AR = "لا يمكن الآن ⏳";

/**
 * §11/§16.12 — نفس عقد guard بتدفق الزبون: رسالة عربية عامة، التفاصيل باللوغ فقط،
 * لا إعادة رمي (إعادة معالجة التحديث عبر الطابور قد تكرر رسائل — الفخ 7).
 * يمرَّر next للمعالج: تدفق السائق مسجَّل قبل تدفق الزبون، وغير السائق يُمرَّر للتالي.
 */
function guard<C extends Context>(
  deps: DriverFlowDeps,
  action: string,
  handler: (ctx: C, next: NextFunction) => Promise<void>,
): (ctx: C, next: NextFunction) => Promise<void> {
  return async (ctx, next) => {
    try {
      await handler(ctx, next);
    } catch (error) {
      console.error(
        JSON.stringify({
          action: "driver_flow_error",
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
            action: "driver_flow_error_reply_failed",
            tenantId: deps.tenantId,
            chatId: ctx.chat?.id ?? null,
            error: replyError instanceof Error ? replyError.message : String(replyError),
          }),
        );
      }
    }
  };
}

interface ResolvedDriver {
  driverId: string;
  status: DriverStatus;
}

/**
 * التعرف على السائق: users بـ telegram_user_id ثم drivers بـ user_id (RLS يحصر
 * بالمستأجر §2.2). قراءة صافية بلا قفل — كل كتابة لاحقة تأخذ قفلها بنفسها (§16.11).
 */
async function resolveDriver(deps: DriverFlowDeps, telegramUserId: number): Promise<ResolvedDriver | null> {
  return withTenant(deps.db, deps.tenantId, async (tx) => {
    const userRows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);
    const user = userRows[0];
    if (!user) return null;

    const driverRows = await tx
      .select({ id: drivers.id, status: drivers.status })
      .from(drivers)
      .where(eq(drivers.userId, user.id))
      .limit(1);
    const driver = driverRows[0];
    if (!driver) return null;

    return { driverId: driver.id, status: driver.status };
  });
}

/** عملة المستأجر للعرض فقط (D5) — جدول tenants استثناء RLS مسمّى (§2.3) فقراءته هنا مشروعة. */
async function tenantCurrency(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.select({ currency: tenants.currency }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`tenantCurrency: tenant ${tenantId} not found`); // §16.12: فشل صاخب
  }
  return row.currency;
}

type ShiftAction = "start" | "end" | "toggle";

/**
 * §3 — قلب الوردية: drivers.status offline↔online + shift_started_at. UPDATE عادي —
 * حالة سائق لا حالة طلب (آلة حالة الطلب وtransition تخص orders حصراً D8).
 * §16.11: قراءة-ثم-كتابة على حالة → FOR UPDATE.
 */
async function flipShift(deps: DriverFlowDeps, driverId: string, action: ShiftAction): Promise<DriverStatus> {
  // P5.1 — المنطق مصدره الوحيد @quickdrop/db (setDriverShift)، مشترك مع قناة السائق PWA.
  return setDriverShift(deps.db, deps.tenantId, driverId, action);
}

/**
 * §4.3 — تعديل بطاقة (رسالة الزر المضغوط): «message is not modified» تُتجاهل بصمت؛
 * أي فشل تعديل آخر → سجّل وأرسل بطاقة جديدة (v1.1: لا حد 48 ساعة على التعديل،
 * لكن أي فشل لأي سبب → رسالة جديدة).
 */
async function safeEditCard(
  ctx: Context,
  deps: DriverFlowDeps,
  text: string,
  keyboard: InlineKeyboard | null,
): Promise<void> {
  try {
    if (keyboard !== null) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.editMessageText(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("message is not modified")) return; // §4.3: التقطها وتجاهلها بصمت
    console.error(
      JSON.stringify({
        action: "driver_card_edit_failed",
        tenantId: deps.tenantId,
        chatId: ctx.chat?.id ?? null,
        error: message,
      }),
    );
    if (keyboard !== null) {
      await ctx.reply(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text);
    }
  }
}

interface TaskView {
  publicCode: string;
  card: string;
  keyboard: InlineKeyboard | null;
}

/** يقرأ صف الطلب من القاعدة (D16: البطاقة من الصفوف، لا من الذاكرة) ويبني بطاقة المهمة. */
async function loadTaskView(deps: DriverFlowDeps, orderId: string): Promise<TaskView | null> {
  return withTenant(deps.db, deps.tenantId, async (tx) => {
    const rows = await tx
      .select({
        publicCode: orders.publicCode,
        status: orders.status,
        pickupText: orders.pickupText,
        dropoffText: orders.dropoffText,
        goodsAmount: orders.goodsAmount,
        codAmount: orders.codAmount,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    const order = rows[0];
    if (!order) return null;
    const currency = await tenantCurrency(tx, deps.tenantId);
    return {
      publicCode: order.publicCode,
      card: taskCard({ ...order, currency }),
      keyboard: taskKeyboard(order.status, orderId),
    };
  });
}

type DriverTransitionResult = { ok: true; view: TaskView } | { ok: false };

/**
 * §5 D8 — زر حالة المهمة: كل التغيير عبر transition() بفاعل driver داخل withTenant.
 * §16.11: نقفل صف الطلب FOR UPDATE ونتحقق أنه مُسند لهذا السائق تحديداً قبل الانتقال
 * (transition يتحقق من الفاعل النوعي «driver» لا من هوية السائق).
 * D9: لا نداء تيليغرام هنا — بناء نص البطاقة صافٍ، والإرسال بعد الالتزام عند المستدعي.
 */
async function applyDriverTransition(
  deps: DriverFlowDeps,
  orderId: string,
  driverId: string,
  to: OrderStatus,
): Promise<DriverTransitionResult> {
  try {
    return await withTenant(deps.db, deps.tenantId, async (tx) => {
      const locked = await tx
        .select({ driverId: orders.driverId })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for("update");
      const row = locked[0];
      if (!row || row.driverId !== driverId) return { ok: false as const }; // ليس طلبه — من صف القاعدة (D16)

      const updated = await transition(tx, { orderId, to, actor: { type: "driver", id: driverId } });
      const currency = await tenantCurrency(tx, deps.tenantId);
      return {
        ok: true as const,
        view: {
          publicCode: updated.publicCode,
          card: taskCard({
            publicCode: updated.publicCode,
            status: updated.status,
            pickupText: updated.pickupText,
            dropoffText: updated.dropoffText,
            goodsAmount: updated.goodsAmount,
            codAmount: updated.codAmount,
            currency,
          }),
          keyboard: taskKeyboard(updated.status, orderId),
        },
      };
    });
  } catch (error) {
    // §5: السباقات محسومة بالقفل — الخاسر يصل هنا بانتقال غير صالح، رسالة لا crash
    if (error instanceof InvalidTransitionError) return { ok: false };
    throw error; // §16.12: ما عداها ليس حالة عمل — يصعد لـ guard
  }
}

// —— التسجيل ——

/**
 * يسجّل معالجات بوت السائق. **يُسجَّل قبل registerCustomerFlow**: معالجات المواقع هنا
 * تمرّر next() لغير السائقين كي يصل موقع الزبون لتدفق إنشاء الطلب، بينما معالج مواقع
 * الزبون لا يمرّر — التسجيل بعده كان سيُسقط مواقع السائقين نهائياً.
 */
export function registerDriverFlow(bot: Bot, deps: DriverFlowDeps): void {
  // —— الوردية: /شفت (قلب) أو زرا ابدأ/أنهِ (reply keyboard) ——
  bot.hears(
    [BTN_SHIFT_START, BTN_SHIFT_END, CMD_SHIFT_AR],
    guard(deps, "shift", async (ctx, next) => {
      if (!ctx.from) return;
      const driver = await resolveDriver(deps, ctx.from.id);
      if (!driver) {
        await next(); // غير سائق كتب نص الزر صدفة — تجاهل بصمت ومرّر لتدفق الزبون
        return;
      }
      const text = ctx.message?.text;
      const action: ShiftAction = text === BTN_SHIFT_START ? "start" : text === BTN_SHIFT_END ? "end" : "toggle";
      const status = await flipShift(deps, driver.driverId, action);
      await ctx.reply(
        status === "online"
          ? "بلّشت ورديتك ✅ خلّي مشاركة الموقع المباشر شغّالة، ورح توصلك عروض الطلبات هون."
          : "أنهيت ورديتك 👋 ما رح توصلك عروض جديدة. تسلم!",
        { reply_markup: shiftKeyboard(status) },
      );
    }),
  );

  // —— off:acc — قبول عرض: answerCallbackQuery فوراً (§4.3) ثم قرار القاعدة (D16) ——
  bot.callbackQuery(
    OFFER_ACCEPT_RE,
    guard(deps, "offer_accept", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3: خلال ثوانٍ وإلا الزر بيضل يحمّل
      const offerId = ctx.match?.[1];
      if (offerId === undefined || !ctx.from) return;
      const driver = await resolveDriver(deps, ctx.from.id);
      if (!driver) return; // غير سائق → تجاهل بصمت

      // §6.2 D16 — القبول ترانزاكشن قاعدة واحدة بأقفال صفوف؛ الرسالة أدناه تُشتق من
      // AcceptResult (صفوف offers/orders)، لا من غياب مفتاح Redis (متطاير لا يثبت شيئاً).
      const result = await deps.acceptOffer(offerId, driver.driverId);
      switch (result.outcome) {
        case "accepted": {
          const view = await loadTaskView(deps, result.orderId);
          if (!view) {
            // مستحيلة عملياً: الطلب التزم بنفس القاعدة للتو — فشل صاخب لا ابتلاع (§16.12)
            throw new Error(`offer_accept: order ${result.orderId} vanished after accept`);
          }
          await safeEditCard(ctx, deps, `معك! الطلب #${escapeHtml(view.publicCode)} 💪\n\n${view.card}`, view.keyboard);
          return;
        }
        case "already_yours":
          // ضغطة مكررة (الفخ 7): بطاقته صارت بطاقة مهمة من الضغطة الأولى — لا نخربها
          await ctx.reply("سبق أن قبلت هذا الطلب ✋");
          return;
        case "taken":
          await safeEditCard(ctx, deps, "استُلم من سائق آخر 😕 التعويض بالعرض الجاي!", null);
          return;
        case "expired":
          await safeEditCard(ctx, deps, "انتهت مهلة العرض ⌛", null);
          return;
        case "not_found":
          await safeEditCard(ctx, deps, "العرض لم يعد متاحاً 🤷", null);
          return;
      }
    }),
  );

  // —— off:rej — رفض عرض ——
  bot.callbackQuery(
    OFFER_REJECT_RE,
    guard(deps, "offer_reject", async (ctx) => {
      await ctx.answerCallbackQuery(); // §4.3
      const offerId = ctx.match?.[1];
      if (offerId === undefined || !ctx.from) return;
      const driver = await resolveDriver(deps, ctx.from.id);
      if (!driver) return;
      await deps.rejectOffer(offerId, driver.driverId);
      await safeEditCard(ctx, deps, "رفضت العرض ❌", null);
    }),
  );

  // —— أزرار حالة المهمة: كل زر = transition بفاعل driver (D8) ثم تحديث البطاقة ——
  const taskActions: { name: string; re: RegExp; to: OrderStatus }[] = [
    { name: "task_picked_up", re: new RegExp(`^${CB_ORDER_PICKUP_PREFIX}:${UUID_CAPTURE}$`), to: "picked_up" },
    // §5: picked_up→in_transit تلقائي عند أول موقع غير مشبوه — هذا الزر الاحتياط المعرّف
    { name: "task_in_transit", re: new RegExp(`^${CB_ORDER_GO_PREFIX}:${UUID_CAPTURE}$`), to: "in_transit" },
    { name: "task_arrived", re: new RegExp(`^${CB_ORDER_ARRIVE_PREFIX}:${UUID_CAPTURE}$`), to: "arrived" },
    { name: "task_delivered", re: new RegExp(`^${CB_ORDER_DELIVER_PREFIX}:${UUID_CAPTURE}$`), to: "delivered" },
  ];
  for (const { name, re, to } of taskActions) {
    bot.callbackQuery(
      re,
      guard(deps, name, async (ctx) => {
        await ctx.answerCallbackQuery(); // §4.3
        const orderId = ctx.match?.[1];
        if (orderId === undefined || !ctx.from) return;
        const driver = await resolveDriver(deps, ctx.from.id);
        if (!driver) return;

        const result = await applyDriverTransition(deps, orderId, driver.driverId, to);
        if (!result.ok) {
          // انتقال غير صالح (سباق مع إلغاء/إسناد آخر §5) أو طلب ليس له — رسالة لا crash
          await ctx.reply(NOT_NOW_AR);
          return;
        }
        // D9: التعديل بعد التزام الترانزاكشن — أزرار المرحلة التالية فقط
        await safeEditCard(ctx, deps, result.view.card, result.view.keyboard);
      }),
    );
  }

  // —— §7 live location: التحديثات تصل edited_message — معالج منفصل (الفخ 9/§4.3)،
  // لا تدخل منطق المحادثة إطلاقاً. غير السائق → تجاهل بصمت (بلا next: ليست رسالة محادثة).
  bot.on(
    "edited_message:location",
    guard(deps, "live_location", async (ctx) => {
      if (!ctx.from) return;
      const driver = await resolveDriver(deps, ctx.from.id);
      if (!driver) return;
      const message = ctx.editedMessage;
      // D6: unix ثوانٍ من تيليغرام → Date صريحة؛ edit_date لحظة النبضة الفعلية
      const recordedAt = new Date((message.edit_date ?? message.date) * 1000);
      await deps.onLocation(driver.driverId, fromTelegram(message.location), recordedAt);
    }),
  );

  // أول نقطة بمشاركة live (أو موقع عادي من سائق): تصل message عادية — نفس المسار.
  // لغير السائق: next() — موقع الزبون جزء من تدفق إنشاء الطلب (customer-flow).
  bot.on(
    "message:location",
    guard(deps, "location", async (ctx, next) => {
      if (!ctx.from) return;
      const driver = await resolveDriver(deps, ctx.from.id);
      if (!driver) {
        await next();
        return;
      }
      const recordedAt = new Date(ctx.message.date * 1000); // D6: تحويل صريح
      await deps.onLocation(driver.driverId, fromTelegram(ctx.message.location), recordedAt);
    }),
  );

  // §11 — إثبات التسليم: صورة من سائق له طلب نشط. لغير السائق → next() (الزبون قد
  // يرسل صوراً بتدفقه). التنزيل من تيليغرام ثم onPodPhoto (الـ worker يعيد الترميز
  // ويخزّن) — كله خارج أي ترانزاكشن قاعدة (D9: نداء الشبكة لا يمسك اتصال قاعدة).
  bot.on(
    "message:photo",
    guard(deps, "pod_photo", async (ctx, next) => {
      if (!ctx.from) return;
      const driver = await resolveDriver(deps, ctx.from.id);
      if (!driver) {
        await next();
        return;
      }
      if (!deps.onPodPhoto) return; // POD معطّل (بلا S3 مُهيّأ) — تجاهل بصمت
      // §11: أكبر مقاس (آخر عنصر) — أوضح إثبات
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;

      let buffer: Buffer;
      try {
        const file = await ctx.api.getFile(largest.file_id);
        if (file.file_path === undefined) return;
        const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
      } catch {
        // §16.12 — لا ابتلاع صامت للفشل، لكن لا نُسقط معالجة التحديث: رسالة لطيفة + لوغ
        console.error(JSON.stringify({ action: "pod_download", outcome: "error", tenantId: deps.tenantId }));
        await ctx.reply("تعذّر استلام الصورة 😕 جرّب تبعتها مرة تانية.");
        return;
      }

      const result = await deps.onPodPhoto(driver.driverId, buffer);
      switch (result.outcome) {
        case "stored":
          await ctx.reply(`استلمنا صورة إثبات التسليم للطلب #${escapeHtml(result.publicCode)} ✅`);
          return;
        case "no_active_order":
          await ctx.reply("ما عندك طلب نشط حالياً لنربط فيه الصورة 🤔");
          return;
        case "rejected":
          await ctx.reply("الصورة غير مقبولة (صيغة أو حجم) 🚫 ابعت صورة عادية أصغر من 10 ميغا.");
          return;
      }
    }),
  );
}
