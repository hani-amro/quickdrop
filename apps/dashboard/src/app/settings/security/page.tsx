import type { Metadata } from "next";
import { SecuritySettings } from "@/components/SecuritySettings";

export const metadata: Metadata = { title: "الأمان — QuickDrop" };

// §10.2 — إعدادات أمان الطاقم: تسجيل المصادقة الثنائية (TOTP). صفحة محروسة
// (middleware يتطلّب جلسة qd_session)؛ التسجيل الفعلي بجلسة الموظف عبر الـ proxy.
export default function SecurityPage() {
  return <SecuritySettings />;
}
