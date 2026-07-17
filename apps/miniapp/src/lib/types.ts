// أشكال عقد الـ API تحت ${VITE_API_BASE}/api/miniapp — مطابقة حرفياً لما يبنيه فريق الـ API.
// D5 — كل مال سلسلة نصية عشرية؛ لا يُحوَّل لـ Number أبداً (الحساب BigInt، العرض عند الحافة فقط).

/** الفخ 6 — نوع نقطة واحد {lat, lng}؛ التحويل لترتيب MapLibre (lng, lat) داخل MapPicker حصراً. */
export interface Point {
  lat: number;
  lng: number;
}

export interface AuthUser {
  id: string | number;
  firstName: string;
}

export interface AuthResponse {
  token: string;
  expiresInSeconds: number;
  user: AuthUser;
}

export interface Restaurant {
  id: string;
  name: string;
  point: Point;
  prepMinutesDefault: number | null;
}

export interface RestaurantsResponse {
  restaurants: Restaurant[];
}

export interface CatalogItem {
  id: string;
  nameAr: string;
  price: string; // D5: مال سلسلة
  isAvailable: boolean;
}

export interface CatalogResponse {
  items: CatalogItem[];
}

export interface CreateOrderItem {
  catalogItemId: string;
  qty: number;
}

export interface CreateOrderRequest {
  merchantId: string;
  items: CreateOrderItem[];
  dropoff: Point;
  dropoffText?: string;
}

export interface CreatedOrder {
  id: string;
  publicCode: string;
  status: string;
  priceTotal: string; // D5
  codAmount: string; // D5
}

export interface CreateOrderResponse {
  order: CreatedOrder;
}
