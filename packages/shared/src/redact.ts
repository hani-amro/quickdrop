// §11 — "اللوغات تمر بـ redactor يمسح phone/token/password patterns" + §4.2: التوكن
// لا يظهر أبداً — لا بالـ logs ولا برسائل الخطأ (الفخ 15: secrets باللوغ).
// دالة نصية صافية تُطبَّق على أي رسالة خطأ/سطر لوغ قبل الطباعة — لا تعتمد على شكل
// الرسالة (JSON أو نص حر) ولا ترمي أبداً: أسوأ حالاتها إعادة النص كما هو.

export const REDACTED = "[redacted]";
export const REDACTED_TOKEN = "[redacted-token]";

// §4.2 — توكن بوت تيليغرام: أرقام:جسم ≥30 خانة (نفس شكل TOKEN_RE ببوابة التوكنات).
// حد الـ 30 يمنع الإيجابيات الكاذبة (أوقات "12:30" ونِسَب "1:2" لا تُمسّ).
const BOT_TOKEN_RE = /\d+:[A-Za-z0-9_-]{30,}/g;

// §11 — هاتف E.164 (+ ثم 8-15 خانة). (?!\d) يمنع مسح نصف رقم أطول من 15 خانة
// (ليس E.164 أصلاً — يُترك كما هو بدل قناع مضلِّل).
const E164_RE = /\+(\d{8,15})(?!\d)/g;

// §11 — قيم حقول JSON نصية اسمها يحوي token/password/secret (بأي حالة أحرف):
// "bot_token":"..." أو "clientSecret": "..." — تُمسح القيمة النصية كاملة (مع دعم
// علامات اقتباس مهرَّبة داخلها)، ويُحفظ فاصل المفتاح كما ورد.
const JSON_SECRET_FIELD_RE = /"([^"\\]*(?:token|password|secret)[^"\\]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/**
 * §11 — قناع هاتف E.164: أول ثلاث خانات (رمز الدولة تقريباً) + آخر خانتين، والحشوة
 * بينهما ثابتة الطول (`+963•••••42`) كي لا يتسرب طول الرقم الحقيقي نفسه.
 */
function maskPhone(digits: string): string {
  return `+${digits.slice(0, 3)}•••••${digits.slice(-2)}`;
}

/**
 * يمسح الأسرار من نص لوغ/خطأ: توكنات بوت تيليغرام، هواتف E.164 (يبقي آخر خانتين)،
 * وقيم حقول token/password/secret بأي JSON نصي. idempotent — تطبيقها مرتين آمن،
 * ونواتج المسح نفسها لا تطابق أياً من الأنماط.
 * الترتيب مقصود: حقول الـ JSON أولاً (تمسح القيمة كاملة حتى لو لم تطابق نمط توكن)،
 * ثم نمط التوكن الخام (توكن داخل URL خطأ HttpError مثلاً)، ثم الهواتف.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(JSON_SECRET_FIELD_RE, `"$1"$2"${REDACTED}"`)
    .replace(BOT_TOKEN_RE, REDACTED_TOKEN)
    .replace(E164_RE, (_match, digits: string) => maskPhone(digits));
}
