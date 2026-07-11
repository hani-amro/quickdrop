"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// §10.1 — الشاشة الافتراضية "الإرسال"؛ التنقل بسيط وثابت أعلى الشاشة.
const LINKS = [
  { href: "/", label: "الإرسال" },
  { href: "/orders/new", label: "طلب جديد" },
  { href: "/drivers", label: "السائقون" },
  { href: "/settlements", label: "التسوية" },
  { href: "/analytics", label: "التحليلات" },
  { href: "/broadcasts", label: "البث" },
] as const;

export function NavBar() {
  const pathname = usePathname();
  // §7 — /t/{token} صفحة تتبع عامة لزائر مجهول: بلا تنقّل الداشبورد إطلاقاً
  if (pathname === "/t" || pathname.startsWith("/t/")) return null;
  // §10.2 — كونسول المشرف نطاق منفصل تماماً بشريطه البرتقالي الخاص: لا تنقّل المكتب هنا
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return null;
  return (
    <header className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex max-w-screen-2xl items-center gap-6 px-4 py-3">
        <span className="text-lg font-bold text-sky-700">
          QuickDrop <span className="text-sm font-normal text-slate-500">داشبورد المكتب</span>
        </span>
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
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
