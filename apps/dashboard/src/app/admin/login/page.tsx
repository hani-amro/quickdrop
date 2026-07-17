"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// §10.2 — دخول مشرف المنصّة: بريد + كلمة سر → جلسة qd_admin (عبر admin-auth-proxy الذي
// ينقل Set-Cookie). لا توكن آلة يُحقن — الجلسة هي السلطة الوحيدة لكونسول المشرف.
export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin-auth-proxy/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        setError("بيانات الدخول غير صحيحة");
        return;
      }
      router.replace("/admin");
      router.refresh();
    } catch {
      setError("تعذّر الاتصال — جرّب مرة تانية");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main dir="rtl" className="flex min-h-dvh items-center justify-center bg-slate-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-bold text-slate-800">كونسول المشرف</h1>
        <p className="mb-4 text-sm text-slate-500">دخول مشرف المنصّة</p>

        <label className="block text-sm text-slate-700">
          البريد
          <input
            type="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            autoComplete="username"
            dir="ltr"
            className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-start text-sm focus:border-sky-500 focus:outline-none"
          />
        </label>
        <label className="mt-3 block text-sm text-slate-700">
          كلمة السر
          <input
            type="password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none"
          />
        </label>

        {error !== null && (
          <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-slate-800 px-4 py-2 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {busy ? "جارٍ الدخول…" : "دخول"}
        </button>
      </form>
    </main>
  );
}
