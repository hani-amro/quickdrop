"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

// E1 — حارس UX (الأمن مفروض خادمياً بـ AdminGuard: جلسة pendingEnroll → 403 على كل /api/admin/*).
// لو الجلسة معلّقة التفعيل، كل نداءات الكونسول ترجع 403 → نحوّل لصفحة الدخول (تستأنف خطوة
// التفعيل) بدل كونسول معطوب. يتخطّى /admin/login نفسها (تدير حالتها وإلا صار تحويل متكرر).
export function AdminEnrollGuard(): null {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/admin/login") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin-auth-proxy/session");
        if (cancelled) return;
        if (res.status === 401) {
          window.location.assign("/admin/login");
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as { pendingEnroll?: boolean };
        if (!cancelled && json.pendingEnroll === true) window.location.assign("/admin/login");
      } catch {
        /* تجاهل — لا نعطّل الكونسول على خطأ شبكي عابر */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);
  return null;
}
