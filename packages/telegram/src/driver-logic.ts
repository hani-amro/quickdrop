import { type OrderStatus } from "@quickdrop/shared";
import { InlineKeyboard } from "grammy";

// §3/§7 — computeIsSuspect وثوابته انتقلت إلى @quickdrop/shared (يستهلكها db أيضاً لقناة
// السائق PWA)؛ نُعيد تصديرها هنا للتوافق مع مستهلكي driver-logic القائمين.
export {
  computeIsSuspect,
  SUSPECT_SPEED_KMH,
  SUSPECT_JUMP_METERS,
  SUSPECT_JUMP_WINDOW_S,
  type LocationSample,
} from "@quickdrop/shared";

// §4.3/§6/§7 — منطق بوت السائق الصافي (بلا قاعدة ولا شبكة): بناء callback_data
// والكيبوردات وفحص is_suspect — قابل للاختبار وحدةً (§15) ويستهلكه driver-flow
// وworker (فحص المواقع) وnotifications (بطاقات العروض).

// —— callback_data (§4.4: حد 64 بايت — معرّفات قصيرة، لا JSON) ——
export const CB_OFFER_ACCEPT_PREFIX = "off:acc";
export const CB_OFFER_REJECT_PREFIX = "off:rej";
export const CB_ORDER_PICKUP_PREFIX = "ord:pu";
export const CB_ORDER_GO_PREFIX = "ord:go"; // §5: picked_up→in_transit — زر السائق fallback
export const CB_ORDER_ARRIVE_PREFIX = "ord:arr";
export const CB_ORDER_DELIVER_PREFIX = "ord:dlv";

/** يبني callback_data ويحرس حد الـ 64 بايت (§4.4) — تجاوزه يرفضه/يقصّه تيليغرام. */
export function buildCallbackData(prefix: string, id: string): string {
  const data = `${prefix}:${id}`;
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > 64) {
    throw new RangeError(`callback_data exceeds Telegram's 64-byte limit (${bytes} bytes): prefix '${prefix}'`);
  }
  return data;
}

export const offerAcceptCb = (offerId: string): string => buildCallbackData(CB_OFFER_ACCEPT_PREFIX, offerId);
export const offerRejectCb = (offerId: string): string => buildCallbackData(CB_OFFER_REJECT_PREFIX, offerId);

/** UUID كامل بالـ callback_data (36 محرفاً) — النمط الدقيق يمنع التقاط بيانات غريبة الشكل. */
export const UUID_CAPTURE = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

/**
 * §6.2 — أزرار عرض الإسناد قبول/رفض. يستهلكها مرسل بطاقات العروض
 * (notifications-consumer) مع offerCard من html.ts.
 */
export function offerKeyboard(offerId: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ اقبل", offerAcceptCb(offerId)).text("❌ ارفض", offerRejectCb(offerId));
}

/**
 * §5 — أزرار بطاقة المهمة: زر المرحلة التالية فقط. picked_up→in_transit يحدث تلقائياً
 * بفاعل system عند أول موقع غير مشبوه — زر «انطلقت» هنا الاحتياط المعرّف بالوثيقة.
 */
export function taskKeyboard(status: OrderStatus, orderId: string): InlineKeyboard | null {
  switch (status) {
    case "assigned":
      return new InlineKeyboard().text("📦 استلمت الطلب", buildCallbackData(CB_ORDER_PICKUP_PREFIX, orderId));
    case "picked_up":
      return new InlineKeyboard().text("🛵 انطلقت", buildCallbackData(CB_ORDER_GO_PREFIX, orderId));
    case "in_transit":
      return new InlineKeyboard().text("🏁 وصلت", buildCallbackData(CB_ORDER_ARRIVE_PREFIX, orderId));
    case "arrived":
      return new InlineKeyboard().text("✅ سلّمت الطلب", buildCallbackData(CB_ORDER_DELIVER_PREFIX, orderId));
    default:
      return null; // delivered/failed/… — لا أزرار سائق؛ المسارات غير السعيدة قرار مكتب (§8.4)
  }
}

