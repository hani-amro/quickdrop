import type {
  AnalyticsResponse,
  BindCodeResponse,
  CatalogItemResponse,
  CloseSettlementResponse,
  CreateBroadcastRequest,
  CreateBroadcastResponse,
  CreateMerchantRequest,
  CreateMerchantResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  ListBroadcastsResponse,
  ListCatalogResponse,
  ListDriversResponse,
  ListMerchantsResponse,
  ListOrdersResponse,
  MerchantConfirmResponse,
  OrderDetailResponse,
  QuoteRequest,
  QuoteResponse,
  SettlementBoardResponse,
  UpsertCatalogItemRequest,
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
  // §10.1 — تفاصيل الطلب للوحة الجانبية (§3 v1: منها merchant + merchantConfirmedAt)
  orderDetail: (orderId: string): Promise<OrderDetailResponse> => request(`orders/${orderId}`),
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
  // §3 v1 — زر "المطعم أكّد": عمود عادي (merchant_confirmed_at) لا حالة؛ يُملأ مرة واحدة
  merchantConfirm: (orderId: string): Promise<MerchantConfirmResponse> =>
    request(`orders/${orderId}/merchant-confirm`, { method: "POST", body: {} }),
  // §8.2 — التسوية اليومية: اللوحة + إغلاق يوم سائق (periodDate يحسبه الخادم
  // بمنطقة المستأجر tenantDay — الفخ 8؛ الواجهة لا ترسل "اليوم" من المتصفح)
  settlementBoard: (): Promise<SettlementBoardResponse> => request("settlements/board"),
  closeSettlement: (driverId: string, received: string): Promise<CloseSettlementResponse> =>
    request("settlements/close", { method: "POST", body: { driverId, received } }),
  // §13 — إحصاءات اللوحة؛ days اختياري (النافذة الافتراضية 7 أيام خادمياً)
  analytics: (days?: number): Promise<AnalyticsResponse> =>
    request(days === undefined ? "analytics" : `analytics?days=${days}`),
  // §4.3/§14 — البث الجماهيري: القائمة + إنشاء بثّة (تُدفع للطابور فوراً خادمياً)
  listBroadcasts: (): Promise<ListBroadcastsResponse> => request("broadcasts"),
  createBroadcast: (body: CreateBroadcastRequest): Promise<CreateBroadcastResponse> =>
    request("broadcasts", { method: "POST", body }),
  // §3 — إدارة التجار وكتالوجهم (شاشة المطاعم): قائمة/إنشاء تاجر، كتالوج، upsert صنف، قلب توفّر
  listMerchants: (): Promise<ListMerchantsResponse> => request("merchants"),
  createMerchant: (body: CreateMerchantRequest): Promise<CreateMerchantResponse> =>
    request("merchants", { method: "POST", body }),
  listCatalog: (merchantId: string): Promise<ListCatalogResponse> => request(`merchants/${merchantId}/catalog`),
  upsertCatalogItem: (merchantId: string, body: UpsertCatalogItemRequest): Promise<CatalogItemResponse> =>
    request(`merchants/${merchantId}/catalog`, { method: "POST", body }),
  setItemAvailability: (merchantId: string, itemId: string, isAvailable: boolean): Promise<CatalogItemResponse> =>
    request(`merchants/${merchantId}/catalog/${itemId}/availability`, { method: "POST", body: { isAvailable } }),
  // §3 (بوت التاجر) — كود/رابط ربط لمرة واحدة يفتحه المشغّل بتيليغرام فيربط حسابه بالمطعم
  createMerchantBindCode: (merchantId: string): Promise<BindCodeResponse> =>
    request(`merchants/${merchantId}/bind-code`, { method: "POST", body: {} }),
  // §10.2 — تسجيل TOTP للطاقم (إلزامي owner/accountant): البدء يولّد سرّاً معلّقاً ويرجع
  // otpauth URL؛ التأكيد بالرمز يثبّته. الجلسة (كوكي qd_session) تُمرَّر عبر الـ proxy.
  totpEnroll: (): Promise<{ otpauthUrl: string }> => request("auth/totp/enroll", { method: "POST", body: {} }),
  totpEnrollConfirm: (token: string): Promise<{ ok: true }> =>
    request("auth/totp/enroll/confirm", { method: "POST", body: { token } }),
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
