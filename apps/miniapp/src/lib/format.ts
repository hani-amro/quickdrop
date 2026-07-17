import { ApiError } from "./api";

export const CURRENCY = "ل.س";

// §5 — تسميات حالات الطلب بالعربي (الفخ 13: عربية من الأصل). الحالة تصل من POST /orders؛
// أي حالة غير معروفة تُعرض كما هي بدل الانكسار.
const STATUS_LABELS: Record<string, string> = {
  draft: "مسودة",
  scheduled: "مجدول",
  pending: "بانتظار التأكيد",
  confirmed: "بحاجة سائق",
  assigned: "أُسند لسائق",
  picked_up: "استُلمت البضاعة",
  in_transit: "بالطريق",
  arrived: "وصل الوجهة",
  delivered: "سُلّم",
  cancelled_by_customer: "ألغاه الزبون",
  cancelled_by_office: "ألغاه المكتب",
  failed: "فشل التوصيل",
  returned: "أُرجع",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

// رسالة خطأ عربية موحّدة من أخطاء الـ API/الشبكة (§16.12 — لا فشل صامت).
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "تعذّر الاتصال بالخادم — تحقّق من الإنترنت وأعد المحاولة";
    if (err.status === 401) return "انتهت صلاحية الجلسة — أعد فتح التطبيق";
    if (err.status === 404) return "غير موجود";
    if (err.status >= 500) return "خطأ في الخادم — أعد المحاولة لاحقاً";
    return "تعذّر إتمام الطلب — أعد المحاولة";
  }
  return "حدث خطأ غير متوقع";
}
