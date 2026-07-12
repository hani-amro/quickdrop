"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// §10.2 — نموذج دخول الطاقم. يرسل بريداً وكلمة سر لـ /api/auth-proxy/login؛ الجلسة
// تعود كوكي HttpOnly (لا يلمسها JS). رسائل الفشل عامة (§11 — لا نكشف السبب).
export function LoginForm() {
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
      const res = await fetch("/api/auth-proxy/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError("بيانات الدخول غير صحيحة");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      dir="rtl"
    >
      <h1 className="mb-1 text-xl font-bold text-slate-900">QuickDrop</h1>
      <p className="mb-6 text-sm text-slate-500">تسجيل دخول الطاقم</p>

      <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">
        البريد الإلكتروني
      </label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
      />

      <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">
        كلمة السر
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
      />

      {error !== null && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-slate-900 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "جارٍ الدخول…" : "دخول"}
      </button>
    </form>
  );
}
