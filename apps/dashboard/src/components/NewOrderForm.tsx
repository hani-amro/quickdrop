"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { Service } from "@quickdrop/shared";
import { api, describeError } from "@/lib/api";
import { serviceLabel } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { normalizePhoneE164 } from "@/lib/phone";
import type { CreateOrderRequest, Point, QuoteResponse } from "@/lib/types";
import { tenantCurrencyConfig } from "@/lib/tenant";
import { PriceBreakdown } from "./PriceBreakdown";
import { useToast } from "./Toast";
import type { PickTarget } from "./MapPicker";

// §10.3 روحية — الخريطة lazy client-only: لا SSR ولا دخول بالحزمة الأولية
const MapPicker = dynamic(() => import("./MapPicker"), {
  ssr: false,
  loading: () => <div className="h-80 animate-pulse rounded-xl bg-slate-100" />,
});

// D15 — شاشة إنشاء طلب يدوي (زبون التلفون/الواتساب): البحث/الإنشاء بالهاتف يتولاه
// الـ API (telegram_user_id NULL)، التسعير بنفس محرك البوت، والسعر يُعرض مفصلاً
// قبل الحفظ (§4.4 إلزامي). الخدمة بهالشاشة: توصيل (food) أو طرد (parcel).
const FORM_SERVICES: { value: Service }[] = [{ value: "food" }, { value: "parcel" }];

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none";

export function NewOrderForm() {
  const toast = useToast();
  const tr = useT();

  // حقول D15
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [service, setService] = useState<Service>("food");
  const [recipientPhone, setRecipientPhone] = useState(""); // الفخ 16: الطلب لشخص آخر
  const [weightText, setWeightText] = useState("");
  const [notes, setNotes] = useState("");

  // الخريطة
  const [pickup, setPickup] = useState<Point | null>(null);
  const [dropoff, setDropoff] = useState<Point | null>(null);
  const [target, setTarget] = useState<PickTarget>("pickup");

  // التسعير والإنشاء
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ publicCode: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const weightG = ((): number | null | undefined => {
    // undefined = غير مدخل؛ null = مدخل لكن غير صالح
    if (service !== "parcel" || weightText.trim() === "") return undefined;
    const n = Number(weightText.trim());
    if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) return null;
    return n;
  })();

  // §4.4 — السعر المعروض يجب أن يطابق ما سيُحفظ حرفياً: أي تغيير بمدخلات
  // التسعير (خدمة/نقاط/وزن) يبطل العرض ويفرض إعادة الحساب قبل الإنشاء.
  useEffect(() => {
    setQuote(null);
  }, [service, pickup, dropoff, weightText]);

  // تحقق نقاط/وزن مع تضييق الأنواع — يعيد المدخلات الجاهزة أو رسالة عربية
  function pricingInputs(): { pickup: Point; dropoff: Point; weightG?: number } | string {
    if (pickup === null) return tr("newOrder.setPickupPoint");
    if (dropoff === null) return tr("newOrder.setDropoffPoint");
    if (weightG === null) return tr("newOrder.invalidWeight");
    return { pickup, dropoff, ...(weightG !== undefined ? { weightG } : {}) };
  }

  async function handleQuote(): Promise<void> {
    const inputs = pricingInputs();
    if (typeof inputs === "string") {
      setFormError(inputs);
      return;
    }
    setFormError(null);
    setQuoting(true);
    try {
      const q = await api.quote({ service, ...inputs });
      setQuote(q);
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setQuoting(false);
    }
  }

  async function handleCreate(): Promise<void> {
    const inputs = pricingInputs();
    if (typeof inputs === "string") {
      setFormError(inputs);
      return;
    }
    const phone = normalizePhoneE164(customerPhone);
    if (phone === null) {
      setFormError(tr("newOrder.invalidCustomerPhone", { example: tenantCurrencyConfig().phonePlaceholder }));
      return;
    }
    let recipient: string | undefined;
    if (recipientPhone.trim() !== "") {
      const normalized = normalizePhoneE164(recipientPhone);
      if (normalized === null) {
        setFormError(tr("newOrder.invalidRecipientPhone"));
        return;
      }
      recipient = normalized;
    }
    if (quote === null) {
      // §4.4: ممنوع الحفظ قبل عرض السعر
      setFormError(tr("newOrder.quoteBeforeCreate"));
      return;
    }

    const body: CreateOrderRequest = {
      service,
      customerPhone: phone,
      ...inputs,
      ...(customerName.trim() !== "" ? { customerName: customerName.trim() } : {}),
      ...(recipient !== undefined ? { recipientPhone: recipient } : {}),
      ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
    };

    setFormError(null);
    setCreating(true);
    try {
      const res = await api.createOrder(body);
      setCreated({ publicCode: res.order.publicCode });
      toast.success(tr("newOrder.orderCreatedToast", { code: res.order.publicCode }));
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setCreating(false);
    }
  }

  function resetAll(): void {
    setCustomerPhone("");
    setCustomerName("");
    setService("food");
    setRecipientPhone("");
    setWeightText("");
    setNotes("");
    setPickup(null);
    setDropoff(null);
    setTarget("pickup");
    setQuote(null);
    setCreated(null);
    setFormError(null);
  }

  // نجاح: الكود بارز (يُملى هاتفياً — §10.1 D15) + رابط للوحة
  if (created !== null) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-emerald-300 bg-emerald-50 p-6 text-center">
        <p className="text-sm text-emerald-800">{tr("newOrder.createdSuccess")}</p>
        <p className="my-3 text-3xl font-black text-emerald-900">
          <bdi>{created.publicCode}</bdi>
        </p>
        <p className="mb-4 text-xs text-slate-500">{tr("newOrder.dictateCodeHint")}</p>
        <div className="flex items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
          >
            {tr("newOrder.toDispatchBoard")}
          </Link>
          <button
            type="button"
            onClick={resetAll}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {tr("newOrder.anotherNewOrder")}
          </button>
        </div>
      </div>
    );
  }

  const targetBtn = (t: PickTarget, label: string, colorOn: string): ReactNode => (
    <button
      type="button"
      onClick={() => setTarget(t)}
      aria-pressed={target === t}
      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
        target === t ? colorOn : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <form
      className="grid items-start gap-6 lg:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void handleCreate();
      }}
    >
      {/* عمود الحقول */}
      <div className="flex flex-col gap-3">
        <label className="block text-sm text-slate-700">
          {tr("newOrder.customerPhone")} <span className="text-red-600">*</span>
          <input
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
            inputMode="tel"
            dir="ltr"
            placeholder={tenantCurrencyConfig().phonePlaceholder}
            className={`${inputCls} text-start`}
          />
        </label>

        <label className="block text-sm text-slate-700">
          {tr("newOrder.customerNameOptional")}
          <input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            maxLength={120}
            className={inputCls}
          />
        </label>

        <fieldset className="text-sm text-slate-700">
          <legend>{tr("newOrder.service")}</legend>
          <div className="mt-1 flex items-center gap-2">
            {FORM_SERVICES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setService(s.value)}
                aria-pressed={service === s.value}
                className={`rounded-lg border px-4 py-1.5 text-sm font-semibold ${
                  service === s.value
                    ? "border-sky-500 bg-sky-100 text-sky-800"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {serviceLabel(tr, s.value)}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm text-slate-700">
          {tr("newOrder.recipientPhoneOptional")}
          <input
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(e.target.value)}
            inputMode="tel"
            dir="ltr"
            placeholder={tenantCurrencyConfig().phonePlaceholder}
            className={`${inputCls} text-start`}
          />
        </label>

        {service === "parcel" && (
          <label className="block text-sm text-slate-700">
            {tr("newOrder.weightGramsOptional")}
            <input
              value={weightText}
              onChange={(e) => setWeightText(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              placeholder={tr("newOrder.weightExample")}
              className={`${inputCls} text-start`}
            />
          </label>
        )}

        <label className="block text-sm text-slate-700">
          {tr("newOrder.notesOptional")}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={1000}
            className={inputCls}
          />
        </label>

        {formError !== null && (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {formError}
          </p>
        )}

        {quote !== null && <PriceBreakdown quote={quote} />}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleQuote()}
            disabled={quoting || pickup === null || dropoff === null}
            className="rounded-lg border border-sky-500 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {quoting ? tr("newOrder.calculating") : tr("newOrder.calculatePrice")}
          </button>
          {/* §4.4 — الإنشاء لا يتاح إلا بعد عرض السعر مفصلاً */}
          <button
            type="submit"
            disabled={creating || quote === null}
            title={quote === null ? tr("newOrder.calculatePriceFirst") : undefined}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? tr("newOrder.creating") : tr("newOrder.createOrder")}
          </button>
        </div>
      </div>

      {/* عمود الخريطة */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {targetBtn("pickup", tr("newOrder.setPickup"), "border-emerald-500 bg-emerald-100 text-emerald-800")}
          {targetBtn("dropoff", tr("newOrder.setDropoff"), "border-red-500 bg-red-100 text-red-800")}
          <span className="text-xs text-slate-500">{tr("newOrder.clickMapHint")}</span>
        </div>
        <MapPicker
          pickup={pickup}
          dropoff={dropoff}
          target={target}
          onPick={(t, point) => {
            if (t === "pickup") {
              setPickup(point);
              // تسلسل طبيعي: بعد الاستلام ينتقل الهدف للتسليم تلقائياً
              if (dropoff === null) setTarget("dropoff");
            } else {
              setDropoff(point);
            }
          }}
        />
        <div className="flex items-center gap-4 text-xs text-slate-600">
          <span>
            <span className="inline-block size-2.5 rounded-full bg-emerald-600" /> {tr("newOrder.pickupLabel")}{" "}
            {pickup !== null ? <bdi>{pickup.lat.toFixed(5)}, {pickup.lng.toFixed(5)}</bdi> : tr("newOrder.notSet")}
          </span>
          <span>
            <span className="inline-block size-2.5 rounded-full bg-red-600" /> {tr("newOrder.dropoffLabel")}{" "}
            {dropoff !== null ? <bdi>{dropoff.lat.toFixed(5)}, {dropoff.lng.toFixed(5)}</bdi> : tr("newOrder.notSet")}
          </span>
        </div>
      </div>
    </form>
  );
}
