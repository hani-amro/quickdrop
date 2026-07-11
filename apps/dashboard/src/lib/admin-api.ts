import { ApiError } from "./api";
import type {
  AdminTenantDetailResponse,
  AdminTenantsResponse,
  CreateTenantRequest,
  CreateTenantResponse,
} from "./admin-types";

// عميل المتصفح لكونسول المشرف — كل النداءات عبر /api/admin-proxy (route handler خادمي
// يحقن Bearer ADMIN_API_TOKEN §10.2)؛ لا URL خارجي ولا سر بالمتصفح. منفصل عن lib/api
// المكتب لكنه يعيد استخدام ApiError العام (مصنّف حالة HTTP بحت).

async function request<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/admin-proxy/${path}`, {
    method: init?.method ?? "GET",
    cache: "no-store",
    ...(init?.body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }
      : {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status);
  }
  return (await res.json()) as T;
}

export const adminApi = {
  // §10.2 — قائمة المستأجرين مع الصحة (استعلام واحد بالخادم؛ الواجهة تعرض فقط)
  listTenants: (): Promise<AdminTenantsResponse> => request("tenants"),
  getTenant: (id: string): Promise<AdminTenantDetailResponse> => request(`tenants/${id}`),
  // §14 — إنشاء مستأجر بلا بوت (الربط لاحقاً بسكربت tenant:provision بالخادم)
  createTenant: (body: CreateTenantRequest): Promise<CreateTenantResponse> =>
    request("tenants", { method: "POST", body }),
  // §14 — التعليق/التفعيل قرار يدوي بزر (لا آلي)؛ الحالة الفعلية تُكتب خادمياً
  setStatus: (id: string, status: "active" | "suspended", reason?: string): Promise<unknown> =>
    request(`tenants/${id}/status`, {
      method: "POST",
      body: { status, ...(reason !== undefined && reason.trim() !== "" ? { reason: reason.trim() } : {}) },
    }),
  // §14 — تمديد التجربة (+14 يوماً افتراضياً)؛ الخادم يحسب النهاية الجديدة (timestamptz)
  extendTrial: (id: string, days: number): Promise<unknown> =>
    request(`tenants/${id}/extend-trial`, { method: "POST", body: { days } }),
  // §14/D5 — تسجيل دفعة يدوية (tenant_payments): المبلغ سلسلة أعداد صحيحة
  registerPayment: (id: string, amount: string, note?: string): Promise<unknown> =>
    request(`tenants/${id}/payments`, {
      method: "POST",
      body: { amount, ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}) },
    }),
};
