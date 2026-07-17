"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "./Toast";

// §10.2 — "الدخول كمكتب" للدعم: جلسة طاقم مقيّدة القراءة (readonly) يُصدِرها المشرف من
// /admin/tenants/:id/impersonate وتُضبط كوكي qd_session. GET /api/auth/me يرجع
// {readonly:true} لهذه الجلسة → نرسم شريطاً برتقالياً دائماً أعلى شاشات الطاقم يمنع
// الخلط بين "مشاهدة الدعم" و"التشغيل الفعلي"، مع "إنهاء المشاهدة" (logout → /admin).

interface MeShape {
  readonly?: boolean;
}

// نطاق شاشات الطاقم فقط: استثنِ /login (بلا جلسة)، /admin (كونسول المشرف بمصادقته)،
// و/t (تتبع عام) — كنمط NavBar تماماً.
function isStaffArea(pathname: string): boolean {
  if (pathname === "/login") return false;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return false;
  if (pathname === "/t" || pathname.startsWith("/t/")) return false;
  return true;
}

export function ImpersonationBanner() {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [readonly, setReadonly] = useState(false);
  const [ending, setEnding] = useState(false);

  // نُعيد الفحص عند كل تنقّل داخل شاشات الطاقم (الدخول كمكتب يحوّل من /admin إلى /):
  // نداء GET خفيف مصادَق؛ 401/غير readonly → لا شريط.
  useEffect(() => {
    if (!isStaffArea(pathname)) {
      setReadonly(false);
      return;
    }
    let alive = true;
    fetch("/api/auth-proxy/me", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<MeShape>) : null))
      .then((data) => {
        if (alive) setReadonly(data !== null && data.readonly === true);
      })
      .catch(() => {
        if (alive) setReadonly(false);
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  if (!isStaffArea(pathname) || !readonly) return null;

  async function endViewing(): Promise<void> {
    setEnding(true);
    try {
      // §10.2 — logout يحذف جلسة المكتب من Redis ويمحو كوكي qd_session (auth-proxy ينقل
      // Set-Cookie للمتصفح). جلسة المشرف مستقلة → نعود لكونسول المشرف.
      const res = await fetch("/api/auth-proxy/logout", { method: "POST" });
      if (!res.ok) throw new Error("logout failed");
      router.push("/admin");
      router.refresh();
    } catch {
      toast.error("تعذّر إنهاء المشاهدة — أعد المحاولة");
      setEnding(false);
    }
  }

  return (
    <div className="sticky top-0 z-30 bg-orange-600 text-white shadow-sm" role="alert">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="text-sm font-semibold">
          👁 أنت تشاهد كمكتب — جلسة مشاهدة للقراءة فقط (دعم)
        </span>
        <button
          type="button"
          onClick={() => void endViewing()}
          disabled={ending}
          className="rounded-lg bg-white px-3 py-1 text-xs font-bold text-orange-700 hover:bg-orange-50 disabled:opacity-60"
        >
          {ending ? "جارٍ الإنهاء…" : "إنهاء المشاهدة"}
        </button>
      </div>
    </div>
  );
}
