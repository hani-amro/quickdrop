import { z } from "zod";

// §4.4 — حالة كل محادثة (وسط تدفق إنشاء طلب) بـ Redis بمفتاح conv:{tenantId}:{chatId}
// مع TTL ساعة. **ليس بالذاكرة** — أي إعادة تشغيل للـ worker بتمسح نص طلب الزبون.
// أزرار الـ inline تحمل callback_data قصيرة ('ord:confirm') لا JSON — حد 64 بايت.

export const CONV_TTL_SECONDS = 3600;

/**
 * الحد الأدنى البنيوي لعميل Redis الذي تحتاجه المحادثة — ioredis يطابقه بنيوياً،
 * والاختبارات الصافية تستبدله بـ Map بلا أي اتصالات (§15).
 */
export interface ConvRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>; // §11 — عدّاد حد المعدل (ioredis يحققه بنيوياً)
  expire(key: string, ttlSeconds: number): Promise<unknown>;
}

// §11 — حدود النظام تمر بـ Zod: ما يعود من Redis مدخل خارجي (كتبته نسخة أقدم ربما).
const convPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// §3 — سطر سلة طلب الطعام: معرّف صنف الكتالوج + الكمية (السعر لقطة تُحسم عند الإنشاء).
const cartLineSchema = z.object({
  catalogItemId: z.string().uuid(),
  qty: z.number().int().positive(),
});
export type CartLine = z.infer<typeof cartLineSchema>;

export const convStateSchema = z.object({
  // §3 — خطوات الطعام: اختيار مطعم ← منيو/سلة ← موقع التسليم ← تأكيد.
  step: z.enum([
    "idle",
    "awaiting_pickup",
    "awaiting_dropoff",
    "awaiting_confirm",
    "food_pick_merchant",
    "food_menu",
    "food_dropoff",
    "food_confirm",
    "support", // §9 — الزبون بوضع مراسلة الدعم: كل نص يُلحَق بخيطه حتى /start أو زر قائمة
  ]),
  service: z.enum(["p2p", "parcel", "food"]).optional(),
  pickup: convPointSchema.optional(), // للطعام: موقع المطعم (نقطة الاستلام) المخزَّن لتمريره
  dropoff: convPointSchema.optional(),
  // D5: bigint لا يمر بـ JSON — الإجمالي المعروض يُحفظ نصاً للمقارنة فقط، لا للحساب
  quoteTotal: z.string().regex(/^-?\d+$/).optional(),
  merchantId: z.string().uuid().optional(), // §3 — المطعم المختار لتدفق الطعام
  cart: z.array(cartLineSchema).optional(), // §3 — سلة أصناف الطعام الجارية
});

export type ConvState = z.infer<typeof convStateSchema>;

export function convKey(tenantId: string, chatId: number): string {
  return `conv:${tenantId}:${chatId}`;
}

/** حالة غائبة/منتهية TTL = idle — الزر الذي يعتمد على حالة منتهية يعيد الزبون للبداية بلطف (§4.4). */
export async function loadConv(redis: ConvRedis, tenantId: string, chatId: number): Promise<ConvState> {
  const raw = await redis.get(convKey(tenantId, chatId));
  if (raw === null) return { step: "idle" };

  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // JSON فاسد — يُعالج أسفل مع فشل الـ schema بنفس المسار الصريح
  }
  const parsed = convStateSchema.safeParse(json);
  if (!parsed.success) {
    // §16.12 — معالجة صريحة لا ابتلاع: نسجّل ونصفّر بدل بوت معلّق حتى انتهاء الـ TTL
    console.error(JSON.stringify({ action: "conv_state_corrupt", tenantId, chatId }));
    await redis.del(convKey(tenantId, chatId));
    return { step: "idle" };
  }
  return parsed.data;
}

export async function saveConv(redis: ConvRedis, tenantId: string, chatId: number, state: ConvState): Promise<void> {
  await redis.set(convKey(tenantId, chatId), JSON.stringify(state), "EX", CONV_TTL_SECONDS);
}

/**
 * يمسح الحالة ويرجع هل كانت موجودة — القيمة تُستخدم كـ"مطالبة" ذرّية عند التأكيد:
 * ضغطتا تأكيد متسابقتان (الفخ 7) → واحدة فقط ترى true وتنشئ الطلب.
 */
export async function clearConv(redis: ConvRedis, tenantId: string, chatId: number): Promise<boolean> {
  const removed = await redis.del(convKey(tenantId, chatId));
  return removed > 0;
}
