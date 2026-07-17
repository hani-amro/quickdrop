import type {
  AuthResponse,
  CatalogResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  RestaurantsResponse,
} from "./types";

// عميل عقد /api/miniapp. الرمز في الذاكرة فقط (لا localStorage) — يُمرَّر صريحاً.
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOpts {
  method?: string;
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(base: string, path: string, opts: RequestOpts): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token !== undefined) headers["Authorization"] = `Bearer ${opts.token}`;

  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal !== undefined) init.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(`${base}/api/miniapp${path}`, init);
  } catch {
    // §16.12 — لا فشل صامت: انقطاع الشبكة يظهر برسالة واضحة
    throw new ApiError(0, "network");
  }

  if (!res.ok) {
    throw new ApiError(res.status, `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}

export function authenticate(
  base: string,
  tenantSlug: string,
  initData: string,
  signal?: AbortSignal,
): Promise<AuthResponse> {
  const opts: RequestOpts = { method: "POST", body: { tenantSlug, initData } };
  if (signal !== undefined) opts.signal = signal;
  return request<AuthResponse>(base, "/auth", opts);
}

export function getRestaurants(base: string, token: string, signal?: AbortSignal): Promise<RestaurantsResponse> {
  const opts: RequestOpts = { token };
  if (signal !== undefined) opts.signal = signal;
  return request<RestaurantsResponse>(base, "/restaurants", opts);
}

export function getCatalog(
  base: string,
  token: string,
  restaurantId: string,
  signal?: AbortSignal,
): Promise<CatalogResponse> {
  const opts: RequestOpts = { token };
  if (signal !== undefined) opts.signal = signal;
  return request<CatalogResponse>(base, `/restaurants/${encodeURIComponent(restaurantId)}/catalog`, opts);
}

/**
 * POST /orders — عند 401 (انتهاء الرمز، TTL 15 دقيقة) يُعاد التوثيق مرة واحدة ثم يُعاد المحاولة.
 * reauth يُعيد رمزاً جديداً (ويُحدّث حالة التطبيق عبر إغلاقه).
 */
export async function createOrder(
  base: string,
  token: string,
  body: CreateOrderRequest,
  reauth: () => Promise<string>,
): Promise<CreateOrderResponse> {
  try {
    return await request<CreateOrderResponse>(base, "/orders", { method: "POST", token, body });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const fresh = await reauth();
      return await request<CreateOrderResponse>(base, "/orders", { method: "POST", token: fresh, body });
    }
    throw err;
  }
}
