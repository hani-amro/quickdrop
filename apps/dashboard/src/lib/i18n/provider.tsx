"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { getMessages, translate, type Messages } from "./messages";
import { LOCALE_COOKIE, localeDir, type Locale } from "./locales";

// مزوّد i18n للعميل: اللغة تأتي محسومة من الخادم (كوكي، بالـ layout) كي لا يومض المحتوى
// ولا يختلف الخادم عن العميل (hydration). التبديل يكتب الكوكي ويعيد التحميل (يعيد الخادم
// ضبط <html lang dir> + الرسائل) — لا حالة عميل معقّدة، مصدر واحد.

interface I18nValue {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (next: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const messages: Messages = useMemo(() => getMessages(locale), [locale]);

  const setLocale = useCallback((next: Locale) => {
    // كوكي سنة، مسار الجذر؛ SameSite=Lax يكفي (تفضيل عرض لا سرّ). ثم إعادة تحميل صلبة.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: localeDir(locale),
      t: (key, vars) => translate(messages, key, vars),
      setLocale,
    }),
    [locale, messages, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

/** اختصار الترجمة وحدها. */
export function useT(): I18nValue["t"] {
  return useI18n().t;
}
