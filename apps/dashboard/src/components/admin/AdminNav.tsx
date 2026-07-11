"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// §10.2 — تنقّل كونسول المشرف: منفصل عن NavBar المكتب. رابطان فقط.
const LINKS = [
  { href: "/admin", label: "المستأجرون" },
  { href: "/admin/onboarding", label: "إضافة مستأجر" },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <ul className="flex items-center gap-1">
      {LINKS.map((link) => {
        // "المستأجرون" يشمل صفحات التفصيل /admin/tenants/*؛ "إضافة مستأجر" مطابقة بادئة
        const active =
          link.href === "/admin"
            ? pathname === "/admin" || pathname.startsWith("/admin/tenants")
            : pathname.startsWith(link.href);
        return (
          <li key={link.href}>
            <Link
              href={link.href}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                active ? "bg-white font-semibold text-orange-700" : "text-orange-50 hover:bg-orange-600"
              }`}
            >
              {link.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
