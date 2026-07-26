"use client";

import { useCallback, useEffect, useState } from "react";

// §10.2 + E1 — دخول مشرف المنصّة بـ TOTP إلزامي، عبر admin-auth-proxy (ينقل Set-Cookie qd_admin):
//   credentials → (لديه سرّ) mfa: كود → verify → /admin
//              → (بلا سرّ) enroll: سرّ/QR → كود → confirm → /admin
// لا توكن آلة يُحقن — الجلسة هي السلطة الوحيدة. عند التحديث في المنتصف: نقرأ session ونستأنف.
type Step = "credentials" | "mfa" | "enroll";

/** يستخرج السرّ الخام من رابط otpauth للإدخال اليدوي (عند تعذّر مسح QR). */
function secretFromOtpauth(url: string): string {
  try {
    return new URL(url).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export default function AdminLoginPage() {
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [otpauth, setOtpauth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const goAdmin = useCallback(() => {
    window.location.assign("/admin"); // ملاحة صلبة كي يرى middleware الكوكي الجديد
  }, []);

  const beginEnroll = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/admin-auth-proxy/totp-enroll", { method: "POST" });
    if (!res.ok) {
      setError("تعذّر بدء التفعيل — جرّب مرة تانية");
      setStep("credentials");
      return;
    }
    const json = (await res.json()) as { otpauthUrl?: string };
    setOtpauth(json.otpauthUrl ?? "");
    setError(null);
    setStep("enroll");
  }, []);

  // استئناف عند التحديث: جلسة معلّقة التفعيل → enroll؛ جلسة كاملة → /admin.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin-auth-proxy/session");
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { pendingEnroll?: boolean };
        if (cancelled) return;
        if (json.pendingEnroll === true) await beginEnroll();
        else goAdmin();
      } catch {
        /* لا جلسة — ابقَ على شاشة البيانات */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beginEnroll, goAdmin]);

  async function submitCredentials(e: React.FormEvent): Promise<void> {
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
      const json = (await res.json()) as { mfaRequired?: boolean; challenge?: string; pendingEnroll?: boolean };
      setCode("");
      if (json.mfaRequired === true && typeof json.challenge === "string") {
        setChallenge(json.challenge);
        setStep("mfa");
      } else {
        await beginEnroll(); // بلا سرّ → التفعيل إلزامي (الكوكي مضبوط الآن)
      }
    } catch {
      setError("تعذّر الاتصال — جرّب مرة تانية");
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin-auth-proxy/totp-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge, token: code.trim() }),
      });
      if (!res.ok) {
        setError("رمز غير صحيح — جرّب مرة تانية");
        return;
      }
      goAdmin();
    } catch {
      setError("تعذّر الاتصال — جرّب مرة تانية");
    } finally {
      setBusy(false);
    }
  }

  async function submitEnrollConfirm(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin-auth-proxy/totp-enroll-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: code.trim() }),
      });
      if (!res.ok) {
        setError("رمز غير صحيح — تأكّد من إضافة المفتاح لتطبيق المصادقة");
        return;
      }
      goAdmin();
    } catch {
      setError("تعذّر الاتصال — جرّب مرة تانية");
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode): React.ReactElement => (
    <main dir="rtl" className="flex min-h-dvh items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-bold text-slate-800">كونسول المشرف</h1>
        {children}
        {error !== null && (
          <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );

  const codeInput = (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={code}
      onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ""))}
      dir="ltr"
      className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-center text-lg tracking-widest focus:border-sky-500 focus:outline-none"
      placeholder="000000"
    />
  );

  const submitBtn = (label: string): React.ReactElement => (
    <button
      type="submit"
      disabled={busy}
      className="mt-4 w-full rounded-lg bg-slate-800 px-4 py-2 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
    >
      {busy ? "جارٍ…" : label}
    </button>
  );

  if (step === "mfa") {
    return shell(
      <form onSubmit={submitMfa}>
        <p className="mb-4 text-sm text-slate-500">أدخل الرمز من تطبيق المصادقة</p>
        <label className="block text-sm text-slate-700">
          رمز التحقّق
          {codeInput}
        </label>
        {submitBtn("تحقّق")}
      </form>,
    );
  }

  if (step === "enroll") {
    const secret = secretFromOtpauth(otpauth);
    return shell(
      <form onSubmit={submitEnrollConfirm}>
        <p className="mb-3 text-sm text-slate-500">
          فعّل المصادقة الثنائية: أضف المفتاح التالي في تطبيق المصادقة (Google Authenticator / Authy)، ثم أدخل الرمز.
        </p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <span className="block text-xs text-slate-500">المفتاح السرّي (إدخال يدوي)</span>
          <code dir="ltr" className="mt-1 block break-all text-sm font-bold tracking-wide text-slate-800">
            {secret}
          </code>
          {otpauth !== "" && (
            <a dir="ltr" href={otpauth} className="mt-2 block break-all text-xs text-sky-600 underline">
              فتح في تطبيق المصادقة
            </a>
          )}
        </div>
        <label className="mt-3 block text-sm text-slate-700">
          رمز التحقّق
          {codeInput}
        </label>
        {submitBtn("تأكيد التفعيل")}
      </form>,
    );
  }

  return shell(
    <form onSubmit={submitCredentials}>
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
      {submitBtn("دخول")}
    </form>,
  );
}
