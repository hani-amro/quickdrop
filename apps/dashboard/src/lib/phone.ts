// D15 — تطبيع هاتف بصيغة E.164 للواجهة: نسخة مطابقة منطقياً لدالة الخادم
// (apps/api/src/orders/orders.util.ts) — الخادم يبقى السلطة (§11)، وهذه فقط
// لرسالة خطأ عربية فورية قبل الإرسال. الأرقام الشرقية (٠٩٥…/۰۹۵…) تُحوَّل ASCII.

const ARABIC_INDIC_ZERO = 0x0660; // ٠..٩
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0; // ۰..۹

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const digit =
      code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO;
    return String(digit);
  });
}

// E.164: + ثم 8..15 خانة لا تبدأ بصفر — الإدخال دولي صراحةً (+ أو 00)،
// لا استنتاج نداء محلي (نظام متعدد المستأجرين لا يفترض بلداً واحداً).
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** يعيد E.164 القانونية أو null — القرار (رسالة عربية) عند المستدعي. */
export function normalizePhoneE164(raw: string): string | null {
  let s = toAsciiDigits(raw).replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) {
    s = `+${s.slice(2)}`;
  }
  return E164_RE.test(s) ? s : null;
}
