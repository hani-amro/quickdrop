import { useCallback } from "react";
import type { ReactNode } from "react";
import { getCatalog } from "../lib/api";
import { useResource } from "../lib/useResource";
import { computeCartTotal, formatMoney } from "../lib/money";
import { CURRENCY } from "../lib/format";
import { cartCount, cartLines } from "../lib/cart";
import type { Cart } from "../lib/cart";
import { CenteredState, QtyControl, Spinner } from "../components/ui";
import type { CatalogItem, CatalogResponse, Restaurant } from "../lib/types";

export function MenuScreen({
  apiBase,
  token,
  restaurant,
  cart,
  onSetQty,
  onContinue,
}: {
  apiBase: string;
  token: string;
  restaurant: Restaurant;
  cart: Cart;
  onSetQty: (item: CatalogItem, qty: number) => void;
  onContinue: () => void;
}): ReactNode {
  const fetcher = useCallback(
    (signal: AbortSignal): Promise<CatalogResponse> => getCatalog(apiBase, token, restaurant.id, signal),
    [apiBase, token, restaurant.id],
  );
  const res = useResource(fetcher);

  const count = cartCount(cart);
  const total = computeCartTotal(cartLines(cart));

  if (res.status === "loading") {
    return (
      <CenteredState title="جارٍ تحميل القائمة…">
        <Spinner />
      </CenteredState>
    );
  }
  if (res.status === "error") {
    return (
      <CenteredState emoji="⚠️" title="تعذّر تحميل القائمة" detail={res.error}>
        <button type="button" className="btn" onClick={res.reload} style={{ maxWidth: 220 }}>
          إعادة المحاولة
        </button>
      </CenteredState>
    );
  }

  const items = res.data?.items ?? [];

  return (
    <>
      <div className="content">
        {items.length === 0 ? <CenteredState emoji="🍽️" title="لا توجد أصناف في هذه القائمة" /> : null}
        {items.map((item) => {
          const qty = cart[item.id]?.qty ?? 0;
          return (
            <div key={item.id} className={`card menu-item${item.isAvailable ? "" : " unavailable"}`}>
              <div className="item-info">
                <span className="item-name">{item.nameAr}</span>
                <span className="price">
                  {formatMoney(item.price)} {CURRENCY}
                  {item.isAvailable ? "" : " • غير متوفّر"}
                </span>
              </div>
              <QtyControl
                qty={qty}
                onDec={() => onSetQty(item, Math.max(0, qty - 1))}
                onInc={() => onSetQty(item, qty + 1)}
                disabled={!item.isAvailable}
              />
            </div>
          );
        })}
      </div>

      <div className="cta">
        <div className="summary-line" style={{ padding: "0 4px 8px" }}>
          <span className="muted">الإجمالي ({count} صنف)</span>
          <strong>
            {formatMoney(total)} {CURRENCY}
          </strong>
        </div>
        <button type="button" className="btn" disabled={count === 0} onClick={onContinue}>
          متابعة للتوصيل
        </button>
      </div>
    </>
  );
}
