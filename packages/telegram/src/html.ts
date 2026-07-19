import { formatMoney, type OrderStatus, type PriceComponents } from "@quickdrop/shared";

// §4.3 — parse_mode HTML حصراً + دالة escape واحدة لكل نص قادم من مستخدم:
// اسم الزبون "أحمد <b>" بيكسر الرسالة أو أسوأ. كل بنّائي الرسائل هنا منطق صافٍ قابل للاختبار.

/** يهرّب المحارف الأربعة التي يفسّرها HTML mode بتيليغرام: & < > " */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// D12 — أسماء الحالات بالعربي للعرض؛ مفاتيح الآلة (§5) تبقى بالإنكليزية بالقاعدة والكود.
export const ORDER_STATUS_LABELS_AR: Record<OrderStatus, string> = {
  draft: "مسودة",
  scheduled: "مجدول",
  pending: "قيد المراجعة",
  confirmed: "مؤكد",
  preparing: "قيد التحضير", // §4.2 — مطبخ (food)
  ready: "جاهز للتوصيل", // §4.2 — مطبخ (food)
  assigned: "مُسند لسائق",
  picked_up: "باستلام الطلب",
  in_transit: "بالطريق",
  arrived: "وصل السائق",
  delivered: "تم التسليم",
  cancelled_by_customer: "ملغى من الزبون",
  cancelled_by_office: "ملغى من المكتب",
  failed: "تعذّر التسليم",
  returned: "مُرجَع",
};

// §10.1 — الأرقام/الأكواد داخل نص عربي: عزل bidi بـ ⁦ (LRI) .. ⁩ (PDI)
function bidiIsolate(text: string): string {
  return `⁦${text}⁩`;
}

/**
 * بطاقة حالة الطلب الحية عند الزبون (تُحفظ رسالتها بـ orders.customer_msg_id §3).
 * formatMoney للعرض فقط (D5) — لا يُستخدم ناتجها بأي حساب.
 */
export function orderCard(input: {
  publicCode: string;
  status: OrderStatus;
  priceTotal: bigint;
  currency: string;
}): string {
  const code = bidiIsolate(`#${escapeHtml(input.publicCode)}`);
  const total = escapeHtml(formatMoney(input.priceTotal, "ar-SY", input.currency));
  return [
    `<b>🧾 طلب ${code}</b>`,
    `الحالة: <b>${ORDER_STATUS_LABELS_AR[input.status]}</b>`,
    `أجرة التوصيل: <b>${bidiIsolate(total)}</b>`,
  ].join("\n");
}

/**
 * §4.4 v1.1 — عرض السعر النهائي مفصّلاً قبل التأكيد **إلزامي** قبل إنشاء أي صف:
 * بسوق COD، السعر المفاجئ عند الباب = نزاع يومي وإلغاءات بعد picked_up.
 * المكوّنات الصفرية لا تُعرض — المعادلة الكاملة (§8.3-1) تبقى مسؤولية المحرك لا العرض.
 */
export function quoteCard(input: { components: PriceComponents; distanceM: number; currency: string }): string {
  const c = input.components;
  const fmt = (amount: bigint): string => bidiIsolate(escapeHtml(formatMoney(amount, "ar-SY", input.currency)));
  const km = bidiIsolate(`${(input.distanceM / 1000).toFixed(1)} كم`);

  const lines: string[] = ["<b>🧮 تفاصيل السعر</b>", `المسافة التقريبية: ${km}`, `الأجرة الأساسية: ${fmt(c.base)}`];
  if (c.distance !== 0n) lines.push(`أجرة المسافة: ${fmt(c.distance)}`);
  if (c.weight !== 0n) lines.push(`أجرة الوزن: ${fmt(c.weight)}`);
  if (c.surge !== 0n) lines.push(`زيادة الذروة: ${fmt(c.surge)}`);
  if (c.minAdjustment !== 0n) lines.push(`تعديل الحد الأدنى: ${fmt(c.minAdjustment)}`);
  if (c.discount !== 0n) lines.push(`الخصم: ${fmt(-c.discount)}`);
  lines.push(`<b>الإجمالي: ${fmt(c.total)}</b>`, "", "تأكيد الطلب؟ 👇");
  return lines.join("\n");
}

// —— §3 بطاقات تدفق الطعام (منيو/سلة/تأكيد) — منطق نصوص صافٍ قابل للاختبار ——

/** §3 — سطر عرض لطلب طعام: اسم الصنف (يُهرَّب §4.3) + الكمية + سعر الوحدة (لقطة D5). */
export interface FoodDisplayLine {
  nameAr: string;
  qty: number;
  unitPrice: bigint;
}

/** أسطر «صنف ×كمية — إجمالي السطر» مهرَّبة ومعزولة bidi (§10.1). */
function foodLineRows(lines: FoodDisplayLine[], fmt: (amount: bigint) => string): string[] {
  return lines.map(
    (l) => `• ${escapeHtml(l.nameAr)} ×${bidiIsolate(String(l.qty))} — ${fmt(l.unitPrice * BigInt(l.qty))}`,
  );
}

/**
 * §3 — بطاقة منيو المطعم مع السلة الجارية: تُعرض/تُحدَّث بعد كل ضغطة إضافة (ci:).
 * الأصناف أزرار inline (تُبنى بالمستدعي)؛ النص هنا يلخّص السلة وقيمة البضاعة.
 * أجرة التوصيل تُحسب على مسافة التسليم لاحقاً (§8: المطابقة بمنطقة dropoff) — لا تُعرض هنا.
 */
export function foodMenuCard(input: { merchantName: string; lines: FoodDisplayLine[]; currency: string }): string {
  const fmt = (amount: bigint): string => bidiIsolate(escapeHtml(formatMoney(amount, "ar-SY", input.currency)));
  const header = `<b>🍽 ${escapeHtml(input.merchantName)}</b>`;
  if (input.lines.length === 0) {
    return [header, "", "سلتك فاضية 🛒 — اضغط أي صنف لإضافته."].join("\n");
  }
  const goods = input.lines.reduce((sum, l) => sum + l.unitPrice * BigInt(l.qty), 0n);
  return [
    header,
    "",
    "🛒 <b>سلتك:</b>",
    ...foodLineRows(input.lines, fmt),
    `الإجمالي (قيمة البضاعة): <b>${fmt(goods)}</b>`,
    "",
    "تابع الإضافة أو اضغط «تم، حدد التوصيل» 👇",
  ].join("\n");
}

/**
 * §3/§4.4 — بطاقة تأكيد طلب الطعام قبل إنشاء أي صف: الأصناف + قيمة البضاعة + تنويه
 * أن أجرة التوصيل تُحسب وتُضاف عند التأكيد (لا سعر مفاجئ §4.4). زر التأكيد يُبنى بالمستدعي.
 */
export function foodConfirmCard(input: { merchantName: string; lines: FoodDisplayLine[]; currency: string }): string {
  const fmt = (amount: bigint): string => bidiIsolate(escapeHtml(formatMoney(amount, "ar-SY", input.currency)));
  const goods = input.lines.reduce((sum, l) => sum + l.unitPrice * BigInt(l.qty), 0n);
  return [
    "<b>🍔 تأكيد طلب الطعام</b>",
    `المطعم: <b>${escapeHtml(input.merchantName)}</b>`,
    "",
    ...foodLineRows(input.lines, fmt),
    `قيمة البضاعة: <b>${fmt(goods)}</b>`,
    "",
    "➕ أجرة التوصيل بتنحسب وتنضاف عند التأكيد.",
    "تأكيد الطلب؟ 👇",
  ].join("\n");
}

/**
 * §3 (بوت التاجر) — بطاقة الطلب الجديد المُرسَلة لمشغّل المطعم مع أزرار قبول (+ مدة
 * تحضير) / رفض (تُبنى عند المستدعي — merchant-flow). تعرض الأصناف وقيمة البضاعة ومنطقة
 * التسليم. أزرار القبول تحمل مدة التحضير، والرفض يلغي الطلب.
 */
export function merchantOrderCard(input: {
  publicCode: string;
  lines: FoodDisplayLine[];
  goodsAmount: bigint;
  dropoffText: string | null;
  currency: string;
}): string {
  const fmt = (amount: bigint): string => bidiIsolate(escapeHtml(formatMoney(amount, "ar-SY", input.currency)));
  const rows = [
    `<b>🔔 طلب جديد #${escapeHtml(input.publicCode)}</b>`,
    "",
    ...foodLineRows(input.lines, fmt),
    `قيمة البضاعة: <b>${fmt(input.goodsAmount)}</b>`,
  ];
  if (input.dropoffText !== null && input.dropoffText.trim() !== "") {
    rows.push("", `📍 التوصيل إلى: ${escapeHtml(input.dropoffText)}`);
  }
  rows.push("", "اقبل الطلب وحدّد مدة التحضير، أو ارفضه 👇");
  return rows.join("\n");
}

// —— بطاقات بوت السائق (§4.3/§6) — منطق صافٍ قابل للاختبار مثل بقية الملف ——

/** نقطة بلا نص عنوان (dropoff_text/pickup_text فارغان) — بديل عرض ثابت. */
const POINT_ONLY_LABEL_AR = "📍 نقطة على الخريطة";

/**
 * §6.2 — بطاقة عرض الإسناد المُرسَلة للسائق مع أزرار قبول/رفض (تُبنى عند المستدعي —
 * انظر offerAcceptCb/offerRejectCb بـ driver-flow). المُهلة تُعرض من offers.expires_at
 * (مصدر الحقيقة الوحيد للمهلة — D16)، وnow معامل صريح: لا new Date() ضمنية (D6)
 * وقابلية اختبار صافية (§15).
 * D13: goods_amount = ما يدفعه السائق للتاجر من جيبته عند الاستلام — يجب أن يراه قبل القبول.
 */
export function offerCard(input: {
  publicCode: string;
  pickupText: string | null;
  dropoffText: string | null;
  distanceM?: number | null;
  /** أجرة التوصيل (orders.price_total) — للعرض فقط (D5). */
  priceTotal: bigint;
  goodsAmount?: bigint;
  codAmount?: bigint;
  currency: string;
  /** §6.2 — جولة التوسيع (offers.round): تُعرض من الجولة الثانية فصاعداً. */
  round?: number;
  expiresAt: Date;
  /** مرجع العد التنازلي — مرّرها صراحةً بالاختبارات؛ الافتراضي لحظة البناء. */
  now?: Date;
}): string {
  const fmt = (amount: bigint): string => bidiIsolate(escapeHtml(formatMoney(amount, "ar-SY", input.currency)));
  const code = bidiIsolate(`#${escapeHtml(input.publicCode)}`);
  const nowMs = (input.now ?? new Date()).getTime(); // فارق زمني لا عرض تقويمي — لا يخالف D6
  const secondsLeft = Math.max(0, Math.ceil((input.expiresAt.getTime() - nowMs) / 1000));
  const goodsAmount = input.goodsAmount ?? 0n;
  const codAmount = input.codAmount ?? 0n;

  const lines: string[] = [
    `<b>🛎 عرض توصيل — طلب ${code}</b>`,
    `الاستلام: ${input.pickupText !== null ? escapeHtml(input.pickupText) : POINT_ONLY_LABEL_AR}`,
    `التسليم: ${input.dropoffText !== null ? escapeHtml(input.dropoffText) : POINT_ONLY_LABEL_AR}`,
  ];
  if (input.distanceM !== undefined && input.distanceM !== null) {
    lines.push(`المسافة: ${bidiIsolate(`${(input.distanceM / 1000).toFixed(1)} كم`)}`);
  }
  lines.push(`أجرة التوصيل: <b>${fmt(input.priceTotal)}</b>`);
  // D13: البضاعة تتسوى فيزيائياً عند الاستلام — السائق يدفعها من جيبته ويستردها ضمن cod
  if (goodsAmount > 0n) lines.push(`تدفع للتاجر عند الاستلام: ${fmt(goodsAmount)}`);
  if (codAmount > 0n) lines.push(`تحصّل من الزبون عند التسليم: ${fmt(codAmount)}`);
  if (input.round !== undefined && input.round > 1) lines.push(`🔁 جولة ${bidiIsolate(String(input.round))}`);
  lines.push("", `⏱ عندك ${bidiIsolate(String(secondsLeft))} ثانية للرد`);
  return lines.join("\n");
}

/**
 * §6.2 — بطاقة مهمة السائق: تحل مكان بطاقة العرض بعد القبول، وتُحدَّث مع كل انتقال
 * حالة (أزرار المرحلة التالية تُبنى بـ taskKeyboard في driver-flow — ليست هنا:
 * هذا الملف منطق نصوص صافٍ). التسمية العربية من ORDER_STATUS_LABELS_AR نفسها.
 */
export function taskCard(input: {
  publicCode: string;
  status: OrderStatus;
  pickupText: string | null;
  dropoffText: string | null;
  goodsAmount: bigint;
  codAmount: bigint;
  currency: string;
}): string {
  const fmt = (amount: bigint): string => bidiIsolate(escapeHtml(formatMoney(amount, "ar-SY", input.currency)));
  const code = bidiIsolate(`#${escapeHtml(input.publicCode)}`);

  const lines: string[] = [
    `<b>🚚 مهمتك — طلب ${code}</b>`,
    `الحالة: <b>${ORDER_STATUS_LABELS_AR[input.status]}</b>`,
    `الاستلام: ${input.pickupText !== null ? escapeHtml(input.pickupText) : POINT_ONLY_LABEL_AR}`,
    `التسليم: ${input.dropoffText !== null ? escapeHtml(input.dropoffText) : POINT_ONLY_LABEL_AR}`,
  ];
  if (input.goodsAmount > 0n) lines.push(`تدفع للتاجر عند الاستلام: ${fmt(input.goodsAmount)}`);
  if (input.codAmount > 0n) lines.push(`تحصّل من الزبون عند التسليم: <b>${fmt(input.codAmount)}</b>`);
  if (input.status === "delivered") lines.push("", "تسليم موفّق 🤝 شكراً!");
  return lines.join("\n");
}
