import type {
  AcceptResult,
  DriverAuthResponse,
  DriverMeResponse,
  DriverStatusTarget,
  OffersResponse,
  OrdersResponse,
} from "./types";

// عميل عقد /api/driver. الرمز يُمرَّر صريحاً بترويسة Authorization (نفس نمط الـ miniapp).
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
}

async function request<T>(base: string, path: string, opts: RequestOpts): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token !== undefined) headers["Authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  let res: Response;
  try {
    res = await fetch(`${base}/api/driver${path}`, init);
  } catch {
    throw new ApiError(0, "network"); // §16.12 — لا فشل صامت
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function authenticate(base: string, tenantSlug: string, code: string): Promise<DriverAuthResponse> {
  return request<DriverAuthResponse>(base, "/auth", { method: "POST", body: { tenantSlug, code } });
}
export function getMe(base: string, token: string): Promise<DriverMeResponse> {
  return request<DriverMeResponse>(base, "/me", { token });
}
export function setShift(base: string, token: string, action: "start" | "end" | "toggle"): Promise<{ status: string }> {
  return request<{ status: string }>(base, "/shift", { method: "POST", token, body: { action } });
}
export function getOrders(base: string, token: string): Promise<OrdersResponse> {
  return request<OrdersResponse>(base, "/orders", { token });
}
export function getOffers(base: string, token: string): Promise<OffersResponse> {
  return request<OffersResponse>(base, "/offers", { token });
}
export function acceptOffer(base: string, token: string, offerId: string): Promise<AcceptResult> {
  return request<AcceptResult>(base, `/offers/${encodeURIComponent(offerId)}/accept`, { method: "POST", token });
}
export function rejectOffer(base: string, token: string, offerId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(base, `/offers/${encodeURIComponent(offerId)}/reject`, { method: "POST", token });
}
export function setStatus(base: string, token: string, orderId: string, to: DriverStatusTarget): Promise<{ ok: boolean; status?: string; reason?: string }> {
  return request<{ ok: boolean; status?: string; reason?: string }>(base, `/orders/${encodeURIComponent(orderId)}/status`, { method: "POST", token, body: { to } });
}
export function postLocation(base: string, token: string, lat: number, lng: number): Promise<{ ok: true; suspect: boolean }> {
  return request<{ ok: true; suspect: boolean }>(base, "/location", { method: "POST", token, body: { lat, lng, recordedAt: new Date().toISOString() } });
}
export function postPod(base: string, token: string, imageBase64: string): Promise<{ outcome: string; publicCode?: string; reason?: string }> {
  return request<{ outcome: string; publicCode?: string; reason?: string }>(base, "/pod", { method: "POST", token, body: { imageBase64 } });
}
