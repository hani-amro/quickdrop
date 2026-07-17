"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { MerchantCategory } from "@quickdrop/shared";
import { api, describeError } from "@/lib/api";
import { normalizePhoneE164 } from "@/lib/phone";
import type { CatalogItemView, CreateMerchantRequest, MerchantView, Point } from "@/lib/types";
import { useToast } from "./Toast";
import type { PickTarget } from "./MapPicker";

// §3 — شاشة إدارة التجار: قائمة المطاعم يسار، وكتالوج المطعم المحدَّد يمين.
// المال سلسلة قروش (D5 — العرض بفواصل الآلاف عند الحافة فقط)، والنقطة {lat,lng} (الفخ 6).
// تحديثات تفاؤلية على قلب التوفّر (يتراجع على أي خطأ مع توست).

// §10.3 روحية — الخريطة lazy client-only: لا SSR ولا دخول بالحزمة الأولية
const MapPicker = dynamic(() => import("./MapPicker"), {
  ssr: false,
  loading: () => <div className="h-80 animate-pulse rounded-xl bg-slate-100" />,
});

// التصنيفات محلياً (لا نجرّ ثابت runtime من shared للحزمة) — النوع type-only يُمحى
const CATEGORY_OPTIONS: { value: MerchantCategory; label: string }[] = [
  { value: "restaurant", label: "مطعم" },
  { value: "shop", label: "محل" },
];
const CATEGORY_LABELS: Record<MerchantCategory, string> = { restaurant: "مطعم", shop: "محل" };

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none";

// السعر: سلسلة أعداد صحيحة (أصغر وحدة) — التحقق نصّي بحت (لا Number على المال)
const PRICE_RE = /^\d{1,15}$/;

export function MerchantsManager() {
  const toast = useToast();
  const [merchants, setMerchants] = useState<MerchantView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const loadMerchants = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listMerchants();
      setMerchants(res.merchants);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadMerchants();
  }, [loadMerchants]);

  const selected = merchants?.find((m) => m.id === selectedId) ?? null;

  function handleCreated(merchant: MerchantView): void {
    setMerchants((current) => [merchant, ...(current ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ar")));
    setSelectedId(merchant.id);
    setShowAdd(false);
    toast.success(`أُضيف التاجر ${merchant.name}`);
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[20rem_1fr]">
      {/* عمود قائمة المطاعم */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">التجار</h2>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            aria-pressed={showAdd}
            className="rounded-lg border border-sky-500 px-3 py-1 text-xs font-semibold text-sky-700 hover:bg-sky-50"
          >
            {showAdd ? "إلغاء" : "+ تاجر جديد"}
          </button>
        </div>

        {loadFailed && (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
            تعذّر تحميل القائمة —{" "}
            <button type="button" onClick={() => void loadMerchants()} className="underline">
              أعد المحاولة
            </button>
          </p>
        )}

        {merchants === null && !loadFailed && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
        {merchants !== null && merchants.length === 0 && (
          <p className="rounded-xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
            لا تجار بعد — أضف أول مطعم
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {(merchants ?? []).map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setSelectedId(m.id)}
                aria-pressed={selectedId === m.id}
                className={`w-full rounded-xl border p-3 text-start transition-colors ${
                  selectedId === m.id
                    ? "border-sky-500 bg-sky-50"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900">
                    <bdi>{m.name}</bdi>
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {CATEGORY_LABELS[m.category]}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                  {m.phone !== null && (
                    <span dir="ltr">
                      <bdi>{m.phone}</bdi>
                    </span>
                  )}
                  {m.prepMinutesDefault !== null && <span>تحضير ~{m.prepMinutesDefault} د</span>}
                  {!m.isActive && <span className="text-red-600">موقوف</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* العمود الأيمن: إضافة تاجر أو كتالوج المحدَّد */}
      <div className="flex flex-col gap-4">
        {showAdd && <AddMerchantForm onCreated={handleCreated} />}
        {selected !== null ? (
          <CatalogPanel merchant={selected} />
        ) : (
          !showAdd && (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
              اختر تاجراً من القائمة لإدارة كتالوجه
            </div>
          )
        )}
      </div>
    </div>
  );
}

// §3 — نموذج إضافة تاجر: الاسم، التصنيف، الهاتف (اختياري)، مدة التحضير (اختياري)،
// ونقطة الموقع بنقرة على الخريطة (نعيد استخدام MapPicker بهدف pickup وحده).
function AddMerchantForm({ onCreated }: { onCreated: (merchant: MerchantView) => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<MerchantCategory>("restaurant");
  const [phone, setPhone] = useState("");
  const [prepText, setPrepText] = useState("");
  const [point, setPoint] = useState<Point | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (name.trim() === "") {
      setError("اسم التاجر مطلوب");
      return;
    }
    if (point === null) {
      setError("حدّد موقع التاجر على الخريطة");
      return;
    }
    let normalizedPhone: string | undefined;
    if (phone.trim() !== "") {
      const normalized = normalizePhoneE164(phone);
      if (normalized === null) {
        setError("رقم الهاتف غير صالح — أدخله بصيغة دولية مثل ‎+963 9xx xxx xxx");
        return;
      }
      normalizedPhone = normalized;
    }
    let prep: number | undefined;
    if (prepText.trim() !== "") {
      const n = Number(prepText.trim());
      if (!Number.isInteger(n) || n <= 0 || n > 600) {
        setError("مدة التحضير غير صالحة — عدد دقائق حتى 600");
        return;
      }
      prep = n;
    }

    const body: CreateMerchantRequest = {
      name: name.trim(),
      category,
      point,
      ...(normalizedPhone !== undefined ? { phone: normalizedPhone } : {}),
      ...(prep !== undefined ? { prepMinutesDefault: prep } : {}),
    };

    setError(null);
    setSaving(true);
    try {
      const res = await api.createMerchant(body);
      onCreated(res.merchant);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4 lg:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-bold text-slate-700">تاجر جديد</h2>

        <label className="block text-sm text-slate-700">
          الاسم <span className="text-red-600">*</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={inputCls} />
        </label>

        <fieldset className="text-sm text-slate-700">
          <legend>التصنيف</legend>
          <div className="mt-1 flex items-center gap-2">
            {CATEGORY_OPTIONS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                aria-pressed={category === c.value}
                className={`rounded-lg border px-4 py-1.5 text-sm font-semibold ${
                  category === c.value
                    ? "border-sky-500 bg-sky-100 text-sky-800"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm text-slate-700">
          الهاتف (اختياري — الموزّع يتصل بالتاجر)
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            dir="ltr"
            placeholder="+963 9xx xxx xxx"
            className={`${inputCls} text-start`}
          />
        </label>

        <label className="block text-sm text-slate-700">
          مدة التحضير الافتراضية بالدقائق (اختياري)
          <input
            value={prepText}
            onChange={(e) => setPrepText(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            placeholder="مثال: 20"
            className={`${inputCls} text-start`}
          />
        </label>

        {error !== null && (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={saving || point === null}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "جارٍ الحفظ…" : "أضف التاجر"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-slate-500">انقر على الخريطة لتحديد موقع التاجر</span>
        <MapPicker
          pickup={point}
          dropoff={null}
          target={"pickup" as PickTarget}
          onPick={(_t, p) => setPoint(p)}
        />
        <div className="text-xs text-slate-600">
          <span className="inline-block size-2.5 rounded-full bg-emerald-600" /> الموقع:{" "}
          {point !== null ? (
            <bdi>
              {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
            </bdi>
          ) : (
            "غير محدد"
          )}
        </div>
      </div>
    </form>
  );
}

// §3 — لوحة الكتالوج للمطعم المحدَّد: قائمة الأصناف (اسم/سعر/توفّر) + إضافة صنف.
function CatalogPanel({ merchant }: { merchant: MerchantView }) {
  const toast = useToast();
  const [items, setItems] = useState<CatalogItemView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setItems(null);
    setLoadFailed(false);
    try {
      const res = await api.listCatalog(merchant.id);
      setItems(res.items);
    } catch {
      setLoadFailed(true);
    }
  }, [merchant.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // إدماج صنف (بعد upsert): استبدال بالمعرّف أو إلحاق، ثم فرز بـ sort_order فالاسم
  const mergeItem = useCallback((item: CatalogItemView): void => {
    setItems((current) => {
      const list = current ?? [];
      const idx = list.findIndex((i) => i.id === item.id);
      const next = idx >= 0 ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item];
      return next.sort((a, b) => a.sortOrder - b.sortOrder || a.nameAr.localeCompare(b.nameAr, "ar"));
    });
  }, []);

  // §3 — قلب التوفّر تفاؤلياً: يُقلَب فوراً بالواجهة ويتراجع على أي خطأ (§10.1 — لا كذب)
  async function toggleAvailability(item: CatalogItemView): Promise<void> {
    const next = !item.isAvailable;
    setItems((current) => (current ?? []).map((i) => (i.id === item.id ? { ...i, isAvailable: next } : i)));
    try {
      const res = await api.setItemAvailability(merchant.id, item.id, next);
      mergeItem(res.item); // مصالحة مع الخادم (المصدر الحقيقي)
    } catch (err) {
      // تراجع: أعِد الحالة السابقة + توست
      setItems((current) => (current ?? []).map((i) => (i.id === item.id ? { ...i, isAvailable: item.isAvailable } : i)));
      toast.error(describeError(err));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-700">
          كتالوج <bdi>{merchant.name}</bdi>
        </h2>
      </div>

      {loadFailed && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
          تعذّر تحميل الكتالوج —{" "}
          <button type="button" onClick={() => void load()} className="underline">
            أعد المحاولة
          </button>
        </p>
      )}

      {items === null && !loadFailed && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}

      {items !== null && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-start text-xs text-slate-500">
                <th className="p-3 text-start font-semibold">الصنف</th>
                <th className="p-3 text-start font-semibold">السعر (قرش)</th>
                <th className="p-3 text-start font-semibold">التوفّر</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <CatalogItemRow
                  key={item.id}
                  merchantId={merchant.id}
                  item={item}
                  onSaved={mergeItem}
                  onToggle={() => void toggleAvailability(item)}
                />
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-6 text-center text-slate-400">
                    لا أصناف بعد — أضف أول صنف أدناه
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <AddItemRow merchantId={merchant.id} onAdded={mergeItem} />
    </div>
  );
}

// §3 — صف صنف: تعديل الاسم/السعر بالمكان (upsert بالـ id) + مفتاح توفّر تفاؤلي.
function CatalogItemRow({
  merchantId,
  item,
  onSaved,
  onToggle,
}: {
  merchantId: string;
  item: CatalogItemView;
  onSaved: (item: CatalogItemView) => void;
  onToggle: () => void;
}) {
  const toast = useToast();
  const [nameAr, setNameAr] = useState(item.nameAr);
  const [price, setPrice] = useState(item.price);
  const [saving, setSaving] = useState(false);

  // مزامنة الحقول إن تغيّر الصنف من الخادم (مصالحة بعد التوفّر مثلاً)
  useEffect(() => {
    setNameAr(item.nameAr);
    setPrice(item.price);
  }, [item.nameAr, item.price]);

  const dirty = nameAr.trim() !== item.nameAr || price.trim() !== item.price;

  async function save(): Promise<void> {
    if (nameAr.trim() === "") {
      toast.error("اسم الصنف مطلوب");
      return;
    }
    if (!PRICE_RE.test(price.trim())) {
      toast.error("السعر غير صالح — عدد صحيح بالقرش");
      return;
    }
    setSaving(true);
    try {
      const res = await api.upsertCatalogItem(merchantId, {
        id: item.id,
        nameAr: nameAr.trim(),
        price: price.trim(),
      });
      onSaved(res.item);
      toast.success("حُفظ الصنف");
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="p-2">
        <input
          value={nameAr}
          onChange={(e) => setNameAr(e.target.value)}
          maxLength={200}
          className="w-full rounded-lg border border-slate-200 p-1.5 text-sm focus:border-sky-500 focus:outline-none"
        />
      </td>
      <td className="p-2">
        <div className="flex items-center gap-2">
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            className="w-28 rounded-lg border border-slate-200 p-1.5 text-start text-sm focus:border-sky-500 focus:outline-none"
          />
          {dirty && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {saving ? "…" : "حفظ"}
            </button>
          )}
        </div>
      </td>
      <td className="p-2">
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={item.isAvailable}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            item.isAvailable
              ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          {item.isAvailable ? "متوفّر" : "غير متوفّر"}
        </button>
      </td>
    </tr>
  );
}

// §3 — صف إضافة صنف جديد (upsert بلا id).
function AddItemRow({
  merchantId,
  onAdded,
}: {
  merchantId: string;
  onAdded: (item: CatalogItemView) => void;
}) {
  const toast = useToast();
  const [nameAr, setNameAr] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(): Promise<void> {
    if (nameAr.trim() === "") {
      toast.error("اسم الصنف مطلوب");
      return;
    }
    if (!PRICE_RE.test(price.trim())) {
      toast.error("السعر غير صالح — عدد صحيح بالقرش");
      return;
    }
    setSaving(true);
    try {
      const res = await api.upsertCatalogItem(merchantId, { nameAr: nameAr.trim(), price: price.trim() });
      onAdded(res.item);
      setNameAr("");
      setPrice("");
      toast.success(`أُضيف ${res.item.nameAr}`);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label className="flex-1 text-xs text-slate-600">
        صنف جديد
        <input
          value={nameAr}
          onChange={(e) => setNameAr(e.target.value)}
          maxLength={200}
          placeholder="مثال: شاورما"
          className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none"
        />
      </label>
      <label className="text-xs text-slate-600">
        السعر (قرش)
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="numeric"
          dir="ltr"
          placeholder="15000"
          className="mt-1 w-32 rounded-lg border border-slate-300 p-2 text-start text-sm focus:border-sky-500 focus:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {saving ? "…" : "أضف الصنف"}
      </button>
    </form>
  );
}
