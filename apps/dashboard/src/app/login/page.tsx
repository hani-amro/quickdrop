import type { Metadata } from "next";
import { LoginForm } from "@/components/LoginForm";

export const metadata: Metadata = { title: "تسجيل الدخول — QuickDrop" };

// §10.2 — دخول الطاقم: بريد + كلمة سر → جلسة cookie (عبر auth-proxy). tenantSlug
// يُفرض من env بالخادم، فلا يظهر بالنموذج.
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-4">
      <LoginForm />
    </main>
  );
}
