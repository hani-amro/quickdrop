import type {
  CreateOrderRequest,
  CreateOrderResponse,
  ListDriversResponse,
  ListOrdersResponse,
  QuoteRequest,
  QuoteResponse,
} from "./types";

// عميل المتصفح — كل النداءات عبر /api/proxy (route handler خادمي يحقن التوكن
// وtenantSlug §11)؛ لا URL خارجي ولا سر بالمتصفح.

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`api error ${status}`);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
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

export const api = {
  // §16.10 — القائمة نداء واحد (الخادم استعلام واحد بـ join)؛ التوزيع على الأعمدة بالواجهة
  listOrders: (): Promise<ListOrdersResponse> => request("orders"),
  listDrivers: (): Promise<ListDriversResponse> => request("drivers"),
  // §4.4 — التسعير بنفس محرك البوت (مصدر حقيقة واحد) قبل الحفظ
  quote: (body: QuoteRequest): Promise<QuoteResponse> => request("orders/quote", { method: "POST", body }),
  createOrder: (body: CreateOrderRequest): Promise<CreateOrderResponse> =>
    request("orders", { method: "POST", body }),
  // D8 — الأفعال أدناه تمر خادمياً من transition() حصراً؛ الواجهة لا تكتب حالة
  confirmOrder: (orderId: string): Promise<unknown> =>
    request(`orders/${orderId}/confirm`, { method: "POST", body: {} }),
  cancelOrder: (orderId: string, reason: string): Promise<unknown> =>
    request(`orders/${orderId}/cancel`, { method: "POST", body: { reason } }),
  // D16 — القبول النهائي قرار القاعدة بأقفال الصفوف؛ الواجهة اقتراح فقط
  assignOrder: (orderId: string, driverId: string): Promise<unknown> =>
    request(`orders/${orderId}/assign`, { method: "POST", body: { driverId } }),
};

// أخطاء عامة بالعربي (§11: الخادم يرد رسائل عامة — الواجهة تترجم الحالة فقط)
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return "مدخلات غير صالحة — تحقق من الحقول";
      case 401:
      case 503:
        return "تعذر التخويل مع الخادم — راجع الإعدادات";
      case 404:
        return "المورد غير موجود";
      case 409:
        return "تعارض بالحالة — حدّث اللوحة وأعد المحاولة";
      case 422:
        return "لا قاعدة تسعير فعّالة لهذه الخدمة/المنطقة";
      case 502:
        return "الخادم غير متاح حالياً";
      default:
        return "خطأ غير متوقع من الخادم";
    }
  }
  return "تعذر الاتصال بالشبكة";
}
