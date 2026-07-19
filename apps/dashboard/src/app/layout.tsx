import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { NavBar } from "@/components/NavBar";
import { ToastProvider } from "@/components/Toast";
import { I18nProvider, localeDir } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuickDrop — Office Dashboard",
  description: "Dispatch, orders, drivers, customers",
};

// دمج WaFlow (§26 / قرار المالك) — **ثنائي الاتجاه**: lang/dir يُشتقّان من كوكي اللغة
// خادمياً (en/ms → LTR، ar → RTL؛ zh لاحقاً). لا RTL مثبّت. كل التنسيق بخصائص منطقية
// (ms/me، start/end) كي يعمل باتجاهين بلا فرع. المزوّد يمرّر اللغة لمكوّنات العميل.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getServerLocale();
  return (
    <html lang={locale} dir={localeDir(locale)}>
      <body className="min-h-dvh">
        <I18nProvider locale={locale}>
          <ToastProvider>
            {/* §10.2 — شريط "أنت تشاهد كمكتب" البرتقالي: يظهر فقط بجلسة readonly (دعم) */}
            <ImpersonationBanner />
            <NavBar />
            <main className="mx-auto max-w-screen-2xl px-4 py-4">{children}</main>
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
