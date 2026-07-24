// دمج WaFlow / توطين — إعدادات العرض لكل عملة (مصدر واحد). المال يُخزَّن عدداً صحيحاً
// بأصغر وحدة متتبَّعة للعملة (D3)؛ `decimals` هي كم من تلك الوحدات تصنع وحدة كبرى
// **للعرض فقط** (MYR: سِن → 2، SYP: ليرة → 0). كما تُشتق منها الافتراضيات المحلية
// (رمز الاتصال الهاتفي، مركز الخريطة المبدئي) بدل ثوابت سوريا المكتوبة يدوياً.

export interface CurrencyConfig {
  /** أس الوحدة الصغرى للعرض (القسمة على 10^decimals). */
  decimals: number;
  /** رمز الاتصال الدولي بلا +، مثل "60". */
  dialCode: string;
  /** نص إرشادي لحقل الهاتف بصيغة البلد. */
  phonePlaceholder: string;
  /** مركز الخريطة المبدئي (عاصمة/مدينة رئيسية للعملة). */
  mapCenter: { lat: number; lng: number };
}

// المفتاح = رمز العملة ISO-4217. أضِف عملات جديدة هنا فقط.
export const CURRENCY_CONFIG: Record<string, CurrencyConfig> = {
  MYR: { decimals: 2, dialCode: "60", phonePlaceholder: "+60 12-345 6789", mapCenter: { lat: 3.139, lng: 101.6869 } }, // كوالالمبور
  SGD: { decimals: 2, dialCode: "65", phonePlaceholder: "+65 8123 4567", mapCenter: { lat: 1.3521, lng: 103.8198 } }, // سنغافورة
  SYP: { decimals: 0, dialCode: "963", phonePlaceholder: "+963 9xx xxx xxx", mapCenter: { lat: 33.5138, lng: 36.2765 } }, // دمشق
  USD: { decimals: 2, dialCode: "1", phonePlaceholder: "+1 555 123 4567", mapCenter: { lat: 3.139, lng: 101.6869 } },
};

const DEFAULT_CONFIG: CurrencyConfig = CURRENCY_CONFIG.MYR!;

export function currencyConfig(currency: string): CurrencyConfig {
  return CURRENCY_CONFIG[currency] ?? DEFAULT_CONFIG;
}

/**
 * تنسيق مبلغ عدد-صحيح بأصغر وحدة للعرض فقط (لا يُستخدم بأي حساب — D5).
 * يقسم على 10^decimals ثم يُنسّق بالرمز والمنازل الصحيحة عبر Intl. يقبل bigint أو
 * سلسلة (المال يصل الحافة سلسلةً لتفادي فقد الدقة فوق 2^53؛ Number هنا للعرض فقط
 * والمبالغ الواقعية أصغر بكثير من الحد).
 */
export function formatMoneyDisplay(minor: bigint | string, currency: string, locale = "en"): string {
  const decimals = currencyConfig(currency).decimals;
  const raw = String(minor);
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return raw; // دفاعي: ليس عدداً
  const value = Number(digits) / 10 ** decimals;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(negative ? -value : value);
}
