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
