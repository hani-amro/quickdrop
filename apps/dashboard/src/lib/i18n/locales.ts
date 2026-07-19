// دمج WaFlow (MERGE_PLAN §26 / قرار المالك 2026-07-19) — الداشبورد **ثنائي الاتجاه**:
// en + ms (LTR) أساسيان، ar (RTL) مدعومة، zh مؤجّلة (تُضاف عبر نفس النظام). الاتجاه
// يتبدّل مع اللغة. الافتراضي en (LTR). منطق نقيّ هنا (قابل للاختبار بلا React/DOM).

export const LOCALES = ["en", "ms", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** كوكي اللغة (يُقرأ خادمياً بالـ layout لضبط <html lang dir>، ويُكتب عميلياً بالمبدّل). */
export const LOCALE_COOKIE = "qd_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** الاتجاه المشتق من اللغة: ar فقط RTL (وzh لاحقاً LTR)؛ الباقي LTR. */
export function localeDir(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** لغة صالحة من قيمة كوكي/هيدر أو الافتراضي — لا نثق بمدخل خارجي. */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** اسم اللغة بلغتها (للمبدّل). */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ms: "Bahasa Melayu",
  ar: "العربية",
};
