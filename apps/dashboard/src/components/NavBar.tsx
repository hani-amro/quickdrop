"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { useT } from "@/lib/i18n";

// §10.1 — الشاشة الافتراضية "الإرسال"؛ التنقل بسيط وثابت أعلى الشاشة. النصوص عبر i18n
// (§26 ثنائي الاتجاه) — المفاتيح ثابتة والعرض حسب اللغة. ms-auto (منطقية) لدفع المبدّل
// للطرف الخلفي باتجاهين.
const LINKS = [
  { href: "/", key: "nav.dispatch" },
  { href: "/orders/new", key: "nav.orders" },
  { href: "/drivers", key: "nav.drivers" },
  { href: "/merchants", key: "nav.merchants" }, // §3 — إدارة التجار وكتالوجهم
  { href: "/settlements", key: "nav.settlements" },
  { href: "/analytics", key: "nav.analytics" },
  { href: "/campaigns", key: "nav.campaigns" }, // §24 — الحملات (بث موجّه لشريحة، P2.6)
  { href: "/inbox", key: "nav.inbox" }, // §24/§4.4 — الوارد الموحّد (دعم + محادثات، CRM)
  { href: "/journeys", key: "nav.journeys" }, // §24 — محرك الأتمتة (P2.5)
  { href: "/settings/security", key: "nav.settings" }, // §10.2 — الأمان/المصادقة الثنائية
] as const;

export function NavBar() {
  const pathname = usePathname();
  const t = useT();
  // §7 — /t/{token} صفحة تتبع عامة لزائر مجهول: بلا تنقّل الداشبورد إطلاقاً
  if (pathname === "/t" || pathname.startsWith("/t/")) return null;
  // §10.2 — كونسول المشرف نطاق منفصل تماماً بشريطه البرتقالي الخاص: لا تنقّل المكتب هنا
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return null;
  return (
    <header className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex max-w-screen-2xl items-center gap-6 px-4 py-3">
        <span className="text-lg font-bold text-sky-700">QuickDrop</span>
        <ul className="flex items-center gap-1">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  pathname === link.href
                    ? "bg-sky-100 font-semibold text-sky-800"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t(link.key)}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ms-auto">
          <LocaleSwitcher />
        </div>
      </nav>
    </header>
  );
}
