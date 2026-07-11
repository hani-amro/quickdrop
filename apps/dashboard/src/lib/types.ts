import type { DriverStatus, OrderStatus, Service } from "@quickdrop/shared";

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
