import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { NavBar } from "@/components/NavBar";
import { ToastProvider } from "@/components/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuickDrop — داشبورد المكتب",
  description: "لوحة الإرسال والطلبات والسائقين",
};

// D12/§10.1 — RTL-first: dir="rtl" وlang="ar" على الجذر؛ الأسفل كله خصائص منطقية.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-dvh">
        <ToastProvider>
          {/* §10.2 — شريط "أنت تشاهد كمكتب" البرتقالي: يظهر فقط بجلسة readonly (دعم) */}
          <ImpersonationBanner />
          <NavBar />
          <main className="mx-auto max-w-screen-2xl px-4 py-4">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
