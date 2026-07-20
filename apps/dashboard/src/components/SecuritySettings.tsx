"use client";

import { useState } from "react";
import { ApiError, api, describeError } from "@/lib/api";
import { useT } from "@/lib/i18n";

// §10.2 — تسجيل المصادقة الثنائية (TOTP) للطاقم. إلزامي لدور owner وaccountant.
// التدفّق: زر التفعيل → POST /api/proxy/auth/totp/enroll يرجع otpauth URL → نعرض
// الـ secret/otpauth كنص قابل للنسخ + تعليمات إضافته يدوياً بتطبيق المصادقة (CSP صارم:
// لا صورة QR من خدمة خارجية ولا مكتبة)، ثم حقل الرمز → POST .../enroll/confirm يثبّته.

// ٠..٩ الشرقية/الفارسية → ASCII (لوحة مفاتيح عربية قد تُدخل أرقاماً شرقية)
function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

// السرّ من otpauth URL (لإدخاله يدوياً بتطبيق المصادقة) — مع fallback بلا URL parser
function extractSecret(otpauthUrl: string): string {
  try {
    const s = new URL(otpauthUrl).searchParams.get("secret");
    if (s !== null && s !== "") return s;
  } catch {
    // تجاهُل — نجرّب regex أدناه
  }
  const m = /[?&]secret=([^&]+)/.exec(otpauthUrl);
  return m !== null && m[1] !== undefined ? decodeURIComponent(m[1]) : "";
}

type Phase =
  | { step: "idle" }
  | { step: "enrolled"; otpauthUrl: string; secret: string }
  | { step: "done" };

export function SecuritySettings() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"secret" | "url" | null>(null);

  async function startEnroll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { otpauthUrl } = await api.totpEnroll();
      setPhase({ step: "enrolled", otpauthUrl, secret: extractSecret(otpauthUrl) });
      setToken("");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(): Promise<void> {
    if (!/^\d{6}$/.test(token)) return;
    setBusy(true);
    setError(null);
    try {
      await api.totpEnrollConfirm(token);
      setPhase({ step: "done" });
    } catch (e) {
      // §11 — الخادم يرد عاماً؛ نترجم الحالة لرسالة مفيدة للطاقم
      if (e instanceof ApiError && e.status === 401) {
        setError(t("security.err401"));
      } else if (e instanceof ApiError && e.status === 400) {
        setError(t("security.err400"));
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, which: "secret" | "url"): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // النص محدَّد ومرئي — يمكن نسخه يدوياً إن تعذّر الوصول للحافظة
    }
  }

  const tokenValid = /^\d{6}$/.test(token);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{t("security.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("security.subtitle")}</p>
      </div>

      {phase.step === "done" ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
          <p className="font-bold">{t("security.doneTitle")}</p>
          <p className="mt-1">{t("security.doneBody")}</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          {phase.step === "idle" && (
            <>
              <p className="text-sm text-slate-600">{t("security.idleDesc")}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void startEnroll()}
                className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {busy ? t("security.preparing") : t("security.enroll")}
              </button>
            </>
          )}

          {phase.step === "enrolled" && (
            <div className="flex flex-col gap-4">
              <ol className="list-inside list-decimal space-y-1 text-sm text-slate-600">
                <li>{t("security.step1")}</li>
                <li>{t("security.step2")}</li>
                <li>{t("security.step3")}</li>
              </ol>

              {/* المفتاح (secret) — الأسهل للإدخال اليدوي */}
              <CopyField
                label={t("security.secret")}
                value={phase.secret}
                copied={copied === "secret"}
                onCopy={() => void copy(phase.secret, "secret")}
                mono
              />

              {/* otpauth URL الكامل — لمن يستطيع لصق الرابط مباشرة */}
              <CopyField
                label={t("security.otpauthUrl")}
                value={phase.otpauthUrl}
                copied={copied === "url"}
                onCopy={() => void copy(phase.otpauthUrl, "url")}
                mono
                small
              />

              <label className="block text-sm text-slate-700">
                {t("security.tokenLabel")}
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={token}
                  onChange={(e) => setToken(toAsciiDigits(e.target.value).replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  dir="ltr"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-center text-lg tracking-[0.4em] tabular-nums outline-none focus:border-slate-500"
                />
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || !tokenValid}
                  onClick={() => void confirmEnroll()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? t("security.confirming") : t("security.confirm")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPhase({ step: "idle" });
                    setError(null);
                    setToken("");
                  }}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}

          {error !== null && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
  mono = false,
  small = false,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  mono?: boolean;
  small?: boolean;
}) {
  const t = useT();
  return (
    <div>
      <p className="mb-1 text-xs text-slate-500">{label}</p>
      <div className="flex items-stretch gap-2">
        <code
          dir="ltr"
          className={`min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800 ${
            mono ? "font-mono" : ""
          } ${small ? "text-xs" : "text-sm"}`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
    </div>
  );
}
