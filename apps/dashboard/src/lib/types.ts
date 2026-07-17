import type { BroadcastStatus, DriverStatus, MerchantCategory, OrderStatus, Service } from "@quickdrop/shared";

// أشكال عقد الـ REST كما يراها المتصفح (عبر /api/proxy).
// D5 — كل مال يعبر الـ JSON سلسلة نصية؛ لا يُحوَّل لـ Number أبداً (العرض فقط عند الحافة).

/** الفخ 6 — نوع نقطة واحد {lat, lng}؛ التحويل لترتيب MapLibre (lng, lat) داخل MapPicker حصراً. */
export interface Point {
  lat: number;
  lng: number;
}

export interface PriceComponentStrings {
  base: string;
  distance: string;
  weight: string;
  surge: string;
  minAdjustment: string;
  discount: string;
  total: string;
}

export interface QuoteResponse {
  components: PriceComponentStrings;
  distanceM: number;
  durationS: number;
}

export interface QuoteRequest {
  service: Service;
  pickup: Point;
  dropoff: Point;
  weightG?: number;
}

export interface CreateOrderRequest {
  service: Service;
  customerPhone: string;
  customerName?: string;
  pickup: Point;
  dropoff: Point;
  recipientPhone?: string; // الطلب لشخص آخر (الفخ 16)
  weightG?: number;
  notes?: string;
}

export interface CreateOrderResponse {
  order: {
    id: string;
    publicCode: string;
    status: OrderStatus;
    priceTotal: string;
    codAmount: string;
    createdAt: string;
  };
  quote: QuoteResponse;
}

// GET /api/orders — الحقول فوق العقد الحالي (الخدمة/السائق/زمن التأكيد) اختيارية
// دفاعياً: عقد الـ API قيد التوسعة عند فريق الـ API؛ الواجهة تعرض "—" عند غيابها
// ولا تنكسر بغيابها أو وجودها.
export interface OrderRow {
  id: string;
  publicCode: string;
  status: OrderStatus;
  priceTotal: string;
  createdAt: string;
  service?: Service;
  driverName?: string | null;
  confirmedAt?: string | null;
}

export interface ListOrdersResponse {
  orders: OrderRow[];
}

// GET /api/orders/:id — تفاصيل الطلب (§10.1). عقد الـ API أوسع (أحداث/عروض/مرفقات)؛
// نُمثّل هنا الحقول التي تعرضها الواجهة فقط (structural typing — الزائد يُتجاهل بأمان).
// §3 v1 — merchant{name,phone} + merchantConfirmedAt يصلان بهذا العقد لا بقائمة اللوحة.
export interface OrderDetail {
  id: string;
  publicCode: string;
  service: Service;
  status: OrderStatus;
  customer: { name: string | null; phone: string | null };
  driver: { id: string; name: string | null } | null;
  merchant: { name: string; phone: string | null } | null; // §3 — الموزّع يتصل بالتاجر
  merchantConfirmedAt: string | null; // §3 v1 — عمود عادي لا حالة (D8)
  pickupText: string | null;
  dropoffText: string | null;
  recipientPhone: string | null;
  notes: string | null;
  price: PriceComponentStrings; // D5: كل مال string
  createdAt: string;
}

export interface OrderDetailResponse {
  order: OrderDetail;
}

// POST /api/orders/:id/merchant-confirm — §3 v1: يعلّم لحظة تأكيد التاجر (يُملأ مرة واحدة)
export interface MerchantConfirmResponse {
  order: { id: string; publicCode: string; merchantConfirmedAt: string };
}

// GET /api/drivers — العقد المتوقع من فريق الـ API (قائمة الإسناد اليدوي §10.1):
// الاسم والحالة والنشِطة/السعة (D14) وآخر نقطة موقع. الحقول العددية اختيارية دفاعياً.
export interface DriverRow {
  id: string;
  name: string;
  status: DriverStatus;
  activeOrders?: number;
  maxConcurrentOrders?: number;
  lastPointAt?: string | null;
}

export interface ListDriversResponse {
  drivers: DriverRow[];
}

// GET /api/settlements/board — §8.2: صف لكل سائق عنده قيود غير مسوّاة.
// expected مال = سلسلة (D5)؛ الحساب بالواجهة BigInt حصراً، لا Number أبداً.
export interface SettlementBoardRow {
  driverId: string;
  name: string | null;
  expected: string;
  entryCount: number;
  lastEntryAt: string;
}

export interface SettlementBoardResponse {
  periodDate: string; // اليوم بمنطقة المستأجر (tenantDay خادمياً — الفخ 8)
  rows: SettlementBoardRow[];
}

// POST /api/settlements/close — §8.2: الفرق يظهر حسابياً ولا يُخفى
export interface CloseSettlementResponse {
  settlement: {
    id: string;
    driverId: string;
    periodDate: string;
    expected: string;
    received: string;
    diff: string;
    status: string;
    closedAt: string | null;
  };
}

// GET /public/track/{token} — عقد صفحة التتبع العام /t/{token} (§7): الحالة + الكود
// + نقطتا التسليم/السائق فقط — لا أسماء ولا أرقام. lastPointAgeS = عمر آخر نقطة
// بالثواني (الفخ 19: تُعرض "آخر موقع معروف قبل X" لا نقطة قديمة بهيئة حيّة).
export interface PublicTrackingResponse {
  status: OrderStatus;
  publicCode: string;
  dropoff: Point;
  driver: { lat: number; lng: number; lastPointAgeS: number } | null;
}

// GET /api/analytics — §13: إحصاءات لوحة المكتب. revenue مال = سلسلة (D5).
export interface AnalyticsStatusCount {
  status: OrderStatus;
  count: number;
}

export interface AnalyticsDailyCount {
  day: string; // YYYY-MM-DD بمنطقة المستأجر (الفخ 8 — محسوب خادمياً)
  count: number;
}

export interface AnalyticsZoneCount {
  zoneId: string;
  name: string;
  count: number;
}

export interface AnalyticsResponse {
  window: { sinceDays: number; timezone: string };
  ordersToday: number;
  ordersWindow: number;
  statusCounts: AnalyticsStatusCount[];
  avgAssignSeconds: number | null;
  avgDeliverySeconds: number | null;
  revenue: string; // D5: مال سلسلة — لا Number
  deliveredCount: number;
  activeDrivers: number;
  daily: AnalyticsDailyCount[];
  topZones: AnalyticsZoneCount[];
}

// GET/POST /api/broadcasts — §4.3/§14: البث الجماهيري بعدّاداته.
export interface BroadcastSummary {
  id: string;
  title: string | null;
  body: string;
  status: BroadcastStatus;
  sentCount: number;
  failedCount: number;
  scheduledAt: string | null;
  createdAt: string;
}

export interface ListBroadcastsResponse {
  broadcasts: BroadcastSummary[];
}

export interface CreateBroadcastRequest {
  title?: string;
  body: string;
}

export interface CreateBroadcastResponse {
  broadcast: BroadcastSummary;
  enqueued: boolean;
}

// §3 — إدارة التجار وكتالوجهم (شاشة المطاعم). المال string (D5)؛ النقطة {lat,lng} (الفخ 6).
export interface MerchantView {
  id: string;
  name: string;
  phone: string | null;
  category: MerchantCategory;
  isActive: boolean;
  prepMinutesDefault: number | null;
  point: Point;
  createdAt: string;
}

export interface ListMerchantsResponse {
  merchants: MerchantView[];
}

export interface CreateMerchantRequest {
  name: string;
  phone?: string;
  category: MerchantCategory;
  point: Point;
  prepMinutesDefault?: number;
}

export interface CreateMerchantResponse {
  merchant: MerchantView;
}

export interface CatalogItemView {
  id: string;
  merchantId: string;
  nameAr: string;
  nameEn: string | null;
  price: string; // D5: مال سلسلة — لا Number
  isAvailable: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ListCatalogResponse {
  items: CatalogItemView[];
}

// §3 — إنشاء/تحديث صنف (upsert): id موجود = تحديث؛ غائب = إنشاء
export interface UpsertCatalogItemRequest {
  id?: string;
  nameAr: string;
  nameEn?: string;
  price: string; // D5
  sortOrder?: number;
}

// §3 (بوت التاجر) — كود/رابط ربط لمرة واحدة (deepLink يفتحه المشغّل بتيليغرام)
export interface BindCodeResponse {
  code: string;
  deepLink: string | null;
  expiresInSeconds: number;
}

export interface CatalogItemResponse {
  item: CatalogItemView;
}
