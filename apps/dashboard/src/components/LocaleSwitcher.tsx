"use client";

import { LOCALES, LOCALE_LABELS, useI18n } from "@/lib/i18n";

// مبدّل اللغة — يكتب الكوكي ويعيد التحميل (الخادم يعيد ضبط الاتجاه والرسائل). خصائص
// منطقية (لا left/right) كي يعمل باتجاهين. مرئي بشريط التنقّل.
export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="inline-flex items-center gap-1 text-sm">
      <span className="sr-only">{t("common.language")}</span>
      <select
        aria-label={t("common.language")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as (typeof LOCALES)[number])}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
