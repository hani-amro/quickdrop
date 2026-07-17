import { z } from "zod";
import { ORDER_STATUSES } from "./statuses.js";

// §1/§10.1 — الوقت الحقيقي: ثوابت Socket.IO المشتركة بين الخادم (apps/api)،
// الناشر (apps/worker) والمستمع (apps/dashboard) — مصدر حقيقة واحد للأسماء
// والأنواع. القاعدة الصلبة (§11): الحمولات المبثوثة للمتصفح معرّفات وحالات
// وإحداثيات فقط — لا PII ولا مبالغ ولا أسماء؛ الداشبورد يعيد الجلب عبر قناته
// الموثّقة (proxy خادمي بتوكن) عند وصول الحدث.

/** §10.1 — namespace لوحة الإرسال على خادم Socket.IO (الـ api). */
export const RT_BOARD_NAMESPACE = "/board";

/**
 * §12-روحاً — قناة Redis pub/sub الوحيدة من الـ worker إلى عقد الـ api: الـ worker
 * ينشر {tenantId, event, payload} JSON، وكل عقدة api مشترِكة تعيد البث **محلياً**
 * لغرفة المستأجر (redis-adapter يبث بين عقد Socket.IO فقط — البث المحلي مع اشتراك
 * كل العقد بهذه القناة يوصل الحدث لكل عميل مرة واحدة بالضبط عند التوسع الأفقي).
 */
export const RT_REDIS_CHANNEL = "quickdrop:rt";

/** §10.1/§2 — غرفة لوحة المستأجر: كل أحداث المستأجر تُبث إليها حصراً — عزل بالغرف. */
export function roomForTenant(tenantId: string): string {
  return `tenant:${tenantId}:board`;
}

// §10.1/§11 — تذكرة اتصال الوقت الحقيقي: الداشبورد (بجلسة صالحة) يطلب تذكرة قصيرة
// العمر من الـ api عبر الـ proxy، ثم يمرّرها بالـ handshake؛ خادم الـ realtime يتحقق
// منها (لمرة واحدة) فيربط الاتصال بمستأجر الجلسة. يستبدل قبول الـ handshake بلا سرّ
// (كان أي مَن يعرف slug عاماً يشترك ببث GPS السائقين). التذكرة عشوائية 128-bit،
// تُستهلك عند أول استخدام، وقصيرة العمر تحدّ نافذة التسريب.
export const REALTIME_TICKET_TTL_S = 60;

export function realtimeTicketKey(ticket: string): string {
  return `rt:ticket:${ticket}`;
}

// —— أسماء الأحداث (socket.emit/on) — ثوابت لا سلاسل مبعثرة ——

export const RT_EVENTS = {
  /** حالة طلب تغيّرت — الداشبورد يعيد الجلب فوراً بدل انتظار دورة polling. */
  orderChanged: "order.changed",
  /** نقطة موقع سائق غير مشبوهة كُتبت — لشاشة الخريطة/اللوحة. */
  driverLocation: "driver.location",
} as const;

export type RtEventName = (typeof RT_EVENTS)[keyof typeof RT_EVENTS];

// —— حمولات الأحداث — types صريحة + Zod: تعبر حدود عمليات (worker → Redis → api
// → متصفح)، والتحقق عند الاستهلاك لا عند الإنتاج فقط (§1/§11) ——

export const orderChangedEventSchema = z.object({
  orderId: z.string().uuid(),
  to: z.enum(ORDER_STATUSES),
});
/** حمولة 'order.changed' — معرّف وحالة فقط (لا PII/مبالغ §11). */
export type OrderChangedEvent = z.infer<typeof orderChangedEventSchema>;

export const driverLocationEventSchema = z.object({
  driverId: z.string().uuid(),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  // ISO 8601 نصاً — الحمولة تُسلسل JSON عبر Redis وSocket.IO؛ لا Date تعبر الحدود
  recordedAt: z.string().datetime(),
});
/** حمولة 'driver.location' — معرّف وإحداثيات ووقت فقط. */
export type DriverLocationEvent = z.infer<typeof driverLocationEventSchema>;

/** رسالة قناة RT_REDIS_CHANNEL — discriminated union على اسم الحدث. */
export const rtMessageSchema = z.discriminatedUnion("event", [
  z.object({
    tenantId: z.string().uuid(),
    event: z.literal(RT_EVENTS.orderChanged),
    payload: orderChangedEventSchema,
  }),
  z.object({
    tenantId: z.string().uuid(),
    event: z.literal(RT_EVENTS.driverLocation),
    payload: driverLocationEventSchema,
  }),
]);
export type RtMessage = z.infer<typeof rtMessageSchema>;

/** حد بنيوي أدنى من ioredis (`publish`) — يستوفيه العميل الحقيقي وأي mock بالاختبارات. */
export interface RtPublishClient {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * §10.1 — نشر حدث وقت حقيقي، **أفضل جهد** عمداً: البث تحسين استجابة فوق polling
 * الاحتياطي (كل 3 ثوانٍ بالداشبورد)، وفشله يجب ألا يُفشل مهمة worker أنجزت عملها
 * الحقيقي (إعادة المهمة = إعادة رسائل تيليغرام ببلاش). ليس ابتلاعاً (§16.12):
 * معالجة صريحة مبررة + لوغ تحذيري منظّم (§13) يجعل الفشل مرئياً بالمراقبة.
 */
export async function publishRt(client: RtPublishClient, message: RtMessage): Promise<void> {
  try {
    await client.publish(RT_REDIS_CHANNEL, JSON.stringify(message));
  } catch (error: unknown) {
    console.warn(
      JSON.stringify({
        action: "rt_publish_failed",
        tenantId: message.tenantId,
        event: message.event,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
