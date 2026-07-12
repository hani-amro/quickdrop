import type { ConvRedis } from "./conversation.js";

// §11 — حد معدل أفعال البوت لكل مستخدم تيليغرام: إنشاء طلب 5/ساعة. عدّاد Redis
// بنافذة منزلقة بسيطة (تبدأ من أول طلب، تنتهي بعد ساعة). المبدأ نقي وقابل للاختبار.

export const ORDER_LIMIT_PER_HOUR = 5;
const WINDOW_S = 3600;

/** نقي: هل تجاوز العدّاد الحدّ؟ (العدّاد بعد الزيادة) */
export function isOverLimit(count: number, limit: number = ORDER_LIMIT_PER_HOUR): boolean {
  return count > limit;
}

/**
 * يزيد عدّاد إنشاء الطلبات للمستخدم ويضبط TTL عند أول طلب بالنافذة. يرجع العدّاد
 * بعد الزيادة (استخدم isOverLimit لتقرير الرفض). المفتاح لكل (مستأجر، مستخدم).
 */
export async function bumpOrderRate(redis: ConvRedis, tenantId: string, telegramUserId: number): Promise<number> {
  const key = `rl:order:${tenantId}:${telegramUserId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_S); // نافذة تبدأ من أول طلب
  return count;
}
