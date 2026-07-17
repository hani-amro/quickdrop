import { useState } from "react";
import type { ReactNode } from "react";
import { createOrder } from "../lib/api";
import { CURRENCY, errorMessage } from "../lib/format";
import { computeCartTotal, formatMoney } from "../lib/money";
import { cartLines } from "../lib/cart";
import type { Cart } from "../lib/cart";
import { useMainButton } from "../lib/telegram";
import type { CreateOrderRequest, CreatedOrder, Restaurant } from "../lib/types";
import type { DropoffValue } from "./DropoffScreen";

export function ConfirmScreen({
  apiBase,
  token,
  reauth,
  restaurant,
  cart,
  dropoff,
  onPlaced,
}: {
  apiBase: string;
  token: string;
  reauth: () => Promise<string>;
  restaurant: Restaurant;
  cart: Cart;
  dropoff: DropoffValue;
  onPlaced: (order: CreatedOrder) => void;
}): ReactNode {
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");

  const lines = cartLines(cart);
  const subtotal = computeCartTotal(lines);

  const place = (): void => {
    if (placing || dropoff.point === null) return;
    setPlacing(true);
    setError("");
    const body: CreateOrderRequest = {
      merchantId: restaurant.id,
      items: lines.map((l) => ({ catalogItemId: l.itemId, qty: l.qty })),
      dropoff: dropoff.point,
    };
    const text = dropoff.text.trim();
    if (text.length > 0) body.dropoffText = text;

    // 401 (انتهاء الرمز، TTL 15د) → إعادة توثيق ومحاولة واحدة داخل createOrder
    createOrder(apiBase, token, body, reauth)
      .then((res) => onPlaced(res.order))
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setPlacing(false);
      });
  };

  // MainButton الخاص بتيليغرام كـ CTA رئيسي (no-op بلا ضرر في المتصفح)
  useMainButton({
    text: placing ? "جارٍ الإرسال…" : "تأكيد الطلب",
    visible: true,
    enabled: !placing && dropoff.point !== null,
    progress: placing,
    onClick: place,
  });

  return (
    <>
      <div className="content">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            {restaurant.name}
          </div>
          {lines.map((l) => (
            <div key={l.itemId} className="summary-line">
              <span>
                {l.nameAr} × {l.qty}
              </span>
              <span>
                {formatMoney(computeCartTotal([l]))} {CURRENCY}
              </span>
            </div>
          ))}
          <div className="summary-line total">
            <span>إجمالي الطعام</span>
            <span>
              {formatMoney(subtotal)} {CURRENCY}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="label">التسليم إلى</div>
          {dropoff.text.trim().length > 0 ? <div>{dropoff.text.trim()}</div> : null}
          {dropoff.point !== null ? (
            <div className="muted" dir="ltr" style={{ textAlign: "end" }}>
              {dropoff.point.lat.toFixed(5)}, {dropoff.point.lng.toFixed(5)}
            </div>
          ) : (
            <div className="error-text">لم يُحدَّد موقع التسليم</div>
          )}
        </div>

        <p className="muted">ملاحظة: تُضاف أجرة التوصيل إلى الإجمالي عند إنشاء الطلب، ويظهر المبلغ النهائي في التأكيد.</p>

        {error.length > 0 ? <p className="error-text">{error}</p> : null}
      </div>

      <div className="cta">
        <button type="button" className="btn" disabled={placing || dropoff.point === null} onClick={place}>
          {placing ? "جارٍ الإرسال…" : "تأكيد الطلب"}
        </button>
      </div>
    </>
  );
}
