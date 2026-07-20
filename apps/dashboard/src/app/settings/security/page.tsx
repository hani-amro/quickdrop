import { SecuritySettings } from "@/components/SecuritySettings";

// §10.2/§24 — إعدادات أمان الطاقم: تسجيل المصادقة الثنائية (TOTP)، ثنائية اللغة. صفحة
// محروسة (middleware يتطلّب جلسة qd_session)؛ التسجيل الفعلي بجلسة الموظف عبر الـ proxy.
// لا metadata لكل صفحة (كباقي الصفحات المنقولة) — عنوان التبويب من التخطيط المُدوّل.
export default function SecurityPage() {
  return <SecuritySettings />;
}
