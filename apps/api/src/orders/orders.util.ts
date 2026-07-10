import type { PriceComponents } from "@quickdrop/shared";

// منطق صافٍ (بلا Nest وبلا قاعدة) — قابل لاختبار الوحدات مباشرة.

// D5 — المال bigint داخلياً؛ عند حافة الـ JSON يصير سلاسل نصية حصراً:
// JSON.stringify يرمي على bigint أصلاً، وNumber يفقد الدقة فوق 2^53.
export interface PriceComponentStrings {
  base: string;
  distance: string;
  weight: string;
  surge: string;
  minAdjustment: string;
  discount: string;
  total: string;
}

export function componentsToStrings(c: PriceComponents): PriceComponentStrings {
  return {
    base: String(c.base),
    distance: String(c.distance),
    weight: String(c.weight),
    surge: String(c.surge),
    minAdjustment: String(c.minAdjustment),
    discount: String(c.discount),
    total: String(c.total),
  };
}

// D15 — رقم الزبون بشاشة الطلب اليدوي: التطبيع قبل التخزين حتى يعمل البحث
// على فهرس (tenant_id, phone_e164) بقيمة قانونية واحدة للرقم الواحد.
// الأرقام الشرقية (٠٩٥…/۰۹۵…) واردة جداً بإدخال عربي — تُحوَّل لـ ASCII أولاً.
const ARABIC_INDIC_ZERO = 0x0660; // ٠..٩
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0; // ۰..۹

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const digit = code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO;
    return String(digit);
  });
}

// E.164: + ثم 8..15 خانة لا تبدأ بصفر. لا استنتاج نداء محلي (09… → +963؟) —
// افتراض بلد واحد خطأ بنظام متعدد المستأجرين؛ الإدخال دولي صراحةً (+ أو 00).
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** يعيد الرقم بصيغة E.164 القانونية أو null إن تعذّر — القرار (400 عامة §11) عند المستدعي. */
export function normalizePhoneE164(raw: string): string | null {
  let s = toAsciiDigits(raw).replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) {
    s = `+${s.slice(2)}`;
  }
  return E164_RE.test(s) ? s : null;
}
