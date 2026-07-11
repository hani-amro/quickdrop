import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/AdminNav";

export const metadata: Metadata = {
  title: "كونسول المشرف — QuickDrop",
  description: "إدارة المنصّة: المستأجرون، دورة الحياة، والمدفوعات",
};

// §10.2 — كونسول المشرف نطاق منفصل تماماً عن داشبورد المكتب: شريط برتقالي مميّز يمنع
// الخلط بين النطاقين (لا "أدوار مرتفعة" بنفس الجلسات)، وتنقّل خاص. NavBar المكتب يُخفى
// على /admin (حارس usePathname داخله). يبقى ToastProvider من الجذر متاحاً للأفعال.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-2xl bg-orange-600 text-white shadow-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-lg font-bold">
            كونسول المشرف{" "}
            <span className="text-sm font-normal text-orange-100">QuickDrop · إدارة المنصّة</span>
          </span>
          <AdminNav />
        </div>
      </header>
      {children}
    </div>
  );
}
