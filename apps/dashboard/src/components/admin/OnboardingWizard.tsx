"use client";

import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/Toast";
import { adminApi } from "@/lib/admin-api";
import { SLUG_PATTERN } from "@/lib/admin-format";
import { ApiError, describeError } from "@/lib/api";

// §14 — معالج onboarding ذاتي: (أ) بيانات المكتب → (ب) تعليمات ربط البوت + لصق التوكن →
// (ج) تأكيد وإنشاء. الربط الفعلي للبوت عبر سكربت tenant:provision بالخادم (getMe +
// تسجيل webhook)؛ الواجهة تُنشئ المستأجر بلا بوت (POST /api/admin/tenants) ثم تعرض أمر
// التشغيل. التوكن الملصوق لا يُرسل للخادم من هنا — يُستخدم فقط لبناء الأمر الجاهز.

const TIMEZONES = [
  "Asia/Damascus",
  "Asia/Beirut",
  "Asia/Amman",
  "Asia/Baghdad",
  "Asia/Riyadh",
  "Asia/Dubai",
  "UTC",
] as const;

type Step = 1 | 2 | 3;

export function OnboardingWizard() {
  const toast = useToast();
  const [step, setStep] = useState<Step>(1);

  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState<string>("Asia/Damascus");
  const [botToken, setBotToken] = useState("");

  const [busy, setBusy] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  const nameArOk = nameAr.trim().length >= 2;
  const nameOk = name.trim().length >= 2;
  const slugOk = SLUG_PATTERN.test(slug);
  const step1Ok = nameArOk && nameOk && slugOk;

  // §14 — أمر ربط البوت بالخادم؛ التوكن يُدرج محلياً فقط (لا يمر بالشبكة من هنا)
  const provisionCmd = `pnpm tenant:provision -- --slug=${slug} --token=${botToken.trim() === "" ? "<التوكن-من-BotFather>" : botToken.trim()}`;

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const res = await adminApi.createTenant({
        name: name.trim(),
        nameAr: nameAr.trim(),
        slug,
        timezone,
      });
      setCreatedSlug(res.tenant.slug);
      toast.success("أُنشئ المكتب — شغّل tenant:provision لربط البوت");
    } catch (error) {
      // §14 — slug مكرّر (409) رسالته محددة؛ ما عداه رسالة عامة (§11)
      if (error instanceof ApiError && error.status === 409) {
        toast.error("المعرّف (slug) مستخدم مسبقاً — اختر معرّفاً آخر");
        setStep(1);
      } else {
        toast.error(describeError(error));
      }
    } finally {
      setBusy(false);
    }
  }

  // ── شاشة النجاح ──────────────────────────────────────────────────────────
  if (createdSlug !== null) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5">
          <h1 className="text-lg font-bold text-emerald-900">تم إنشاء المكتب ✅</h1>
          <p className="mt-1 text-sm text-emerald-800">
            المكتب <bdi className="font-semibold">{nameAr}</bdi> (
            <bdi dir="ltr">{createdSlug}</bdi>) جاهز بلا بوت. لإتمام الربط شغّل الأمر التالي على
            الخادم — يتحقق من التوكن بـ <span dir="ltr">getMe</span> ويسجّل الـ webhook:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100" dir="ltr">{provisionCmd}</pre>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin"
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700"
          >
            العودة لقائمة المستأجرين
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-900">إضافة مستأجر</h1>
        <ol className="flex items-center gap-1 text-xs">
          {(["بيانات المكتب", "ربط البوت", "تأكيد"] as const).map((label, i) => {
            const n = (i + 1) as Step;
            return (
              <li
                key={label}
                className={`rounded-full px-2.5 py-1 font-semibold ${
                  step === n
                    ? "bg-orange-600 text-white"
                    : step > n
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-100 text-slate-500"
                }`}
              >
                {n}. {label}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        {/* ── الخطوة أ: بيانات المكتب ── */}
        {step === 1 && (
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-slate-600">الاسم بالعربي</span>
              <input
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
                placeholder="مكتب السرعة للتوصيل"
                maxLength={80}
                className="rounded-lg border border-slate-300 p-2 focus:border-orange-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-600">الاسم اللاتيني (للفواتير/الأنظمة)</span>
              <input
                dir="ltr"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Speed Delivery"
                maxLength={80}
                className="rounded-lg border border-slate-300 p-2 text-start focus:border-orange-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-600">المعرّف (slug) — أحرف صغيرة/أرقام/شرطة، ٢–٣٢</span>
              <input
                dir="ltr"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="speed-delivery"
                maxLength={32}
                className={`rounded-lg border p-2 text-start tabular-nums focus:outline-none ${
                  slug === "" || slugOk ? "border-slate-300 focus:border-orange-500" : "border-red-400"
                }`}
              />
              {slug !== "" && !slugOk && (
                <span className="text-xs text-red-600">
                  المعرّف يجب أن يكون أحرفاً لاتينية صغيرة/أرقام/شرطة (٢–٣٢ محرفاً)
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-600">المنطقة الزمنية (تحسب «اليوم» المالي — الفخ 8)</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                dir="ltr"
                className="rounded-lg border border-slate-300 p-2 text-start focus:border-orange-500 focus:outline-none"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!step1Ok}
                onClick={() => setStep(2)}
                className="rounded-lg bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                التالي: ربط البوت
              </button>
            </div>
          </div>
        )}

        {/* ── الخطوة ب: تعليمات ربط البوت + لصق التوكن ── */}
        {step === 2 && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 p-3 text-slate-700">
              <p className="font-semibold text-slate-900">خطوات إنشاء البوت في تيليغرام</p>
              <ol className="mt-2 list-decimal space-y-1 pe-5">
                <li>
                  افتح محادثة مع <bdi dir="ltr" className="font-semibold">@BotFather</bdi> في تيليغرام.
                </li>
                <li>
                  أرسل <bdi dir="ltr" className="font-mono">/newbot</bdi> واتبع التعليمات (اسم البوت
                  ثم معرّفه المنتهي بـ <bdi dir="ltr">bot</bdi>).
                </li>
                <li>ينسخ BotFather توكناً طويلاً — الصقه في الحقل أدناه.</li>
              </ol>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-slate-600">توكن البوت (من BotFather)</span>
              <input
                dir="ltr"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456789:AA…"
                className="rounded-lg border border-slate-300 p-2 text-start font-mono text-xs focus:border-orange-500 focus:outline-none"
              />
            </label>
            {/* §14/§11 — التوكن لا يُرسل للخادم من الواجهة؛ الربط الآمن (getMe + webhook) بالسكربت */}
            <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
              التوكن لا يُرسل للخادم من هنا — يُستخدم فقط لبناء أمر التشغيل. الربط الفعلي عبر سكربت
              <bdi dir="ltr" className="font-mono"> tenant:provision </bdi>
              الذي يتحقق بـ <bdi dir="ltr">getMe</bdi> ويسجّل الـ webhook.
            </p>
            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50"
              >
                رجوع
              </button>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="rounded-lg bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700"
              >
                التالي: تأكيد
              </button>
            </div>
          </div>
        )}

        {/* ── الخطوة ج: التأكيد والإنشاء ── */}
        {step === 3 && (
          <div className="flex flex-col gap-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-slate-500">الاسم بالعربي</dt>
              <dd className="font-semibold text-slate-900">
                <bdi>{nameAr}</bdi>
              </dd>
              <dt className="text-slate-500">الاسم اللاتيني</dt>
              <dd className="font-semibold text-slate-900">
                <bdi dir="ltr">{name}</bdi>
              </dd>
              <dt className="text-slate-500">المعرّف</dt>
              <dd className="font-semibold text-slate-900">
                <bdi dir="ltr">{slug}</bdi>
              </dd>
              <dt className="text-slate-500">المنطقة الزمنية</dt>
              <dd className="font-semibold text-slate-900">
                <bdi dir="ltr">{timezone}</bdi>
              </dd>
              <dt className="text-slate-500">البوت</dt>
              <dd className="text-slate-700">
                {botToken.trim() === "" ? "يُربط لاحقاً بالسكربت" : "توكن مُجهّز — يُربط بالسكربت"}
              </dd>
            </dl>
            <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
              سيُنشأ المكتب بحالة «تجربة» بلا بوت. بعد الإنشاء شغّل أمر
              <bdi dir="ltr" className="font-mono"> tenant:provision </bdi>
              لربط البوت.
            </p>
            <div className="flex justify-between">
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep(2)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                رجوع
              </button>
              <button
                type="button"
                disabled={busy || !step1Ok}
                onClick={() => void create()}
                className="rounded-lg bg-orange-600 px-4 py-2 font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "جارٍ الإنشاء…" : "إنشاء المكتب"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
