export interface DriverProfile {
  id: string;
  name: string | null;
  status: string;
}
export interface DriverAuthResponse {
  token: string;
  expiresInSeconds: number;
  driver: DriverProfile;
}
export interface DriverMeResponse {
  driver: DriverProfile;
}
export interface DriverOrderView {
  id: string;
  publicCode: string;
  status: string;
  pickupText: string | null;
  dropoffText: string | null;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  priceTotal: string;
  codAmount: string;
  goodsAmount: string;
}
export interface DriverOfferView extends DriverOrderView {
  offerId: string;
  round: number;
  expiresAt: string;
}
export interface OrdersResponse {
  orders: DriverOrderView[];
}
export interface OffersResponse {
  offers: DriverOfferView[];
}
export interface AcceptResult {
  outcome: "accepted" | "already_yours" | "taken" | "expired" | "not_found";
  orderId?: string;
}
export type DriverStatusTarget = "picked_up" | "in_transit" | "arrived" | "delivered" | "failed";
