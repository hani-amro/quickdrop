import type { TenantPlan, TenantStatus } from "@quickdrop/shared";

// §14 — دورة حياة المستأجر: trial → active → past_due → suspended → churned.
// التسميات عربية من البداية (الفخ 13: لا ترجمة).
export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  trial: "تجربة",
  active: "فعّال",
  past_due: "متأخر الدفع",
  suspended: "موقوف",
  churned: "منسحب",
};

// ألوان الحالة (متطلب الشاشة): trial رمادي، active أخضر، past_due أصفر، suspended أحمر،
// churned رمادي غامق. الموزّع/المشرف يمسح بعينه لا يقرأ (§10.1 روحية).
export const TENANT_STATUS_BADGE: Record<TenantStatus, string> = {
  trial: "bg-slate-100 text-slate-600",
  active: "bg-emerald-100 text-emerald-800",
  past_due: "bg-amber-100 text-amber-800",
  suspended: "bg-red-100 text-red-800",
  churned: "bg-slate-300 text-slate-600",
};

// §14 — الباقات بعدد السائقين: starter(3) / growth(10) / pro(بلا حد) + رسم إعداد
export const TENANT_PLAN_LABELS: Record<TenantPlan, string> = {
  starter: "مبتدئ · ٣ سائقين",
  growth: "نمو · ١٠ سائقين",
  pro: "احترافي · بلا حد",
};

// نفس قيد slug عند provision-tenant / الـ API (مرآة للتحقق قبل الإرسال — §11 لا بديل عنه خادمياً)
export const SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;

// §14 — المتبقّي من التجربة بالأيام (سالب = منتهية). null إذا لا تاريخ.
export function trialDaysLeft(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

// إدخال مبلغ: أرقام فقط — الأرقام الشرقية (٠..٩ / ۰..۹) تُحوَّل ASCII (إدخال عربي وارد).
// D5 — المال عدد صحيح؛ الليرة السورية بلا كسور. سقف 15 خانة كقيود الخادم.
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

export function sanitizeMoneyInput(raw: string): string {
  const ascii = raw.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const digit =
      code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO;
    return String(digit);
  });
  return ascii.replace(/\D/g, "").slice(0, 15);
}
