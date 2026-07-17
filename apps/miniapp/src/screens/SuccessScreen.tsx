import type { ReactNode } from "react";
import { CURRENCY, statusLabel } from "../lib/format";
import { formatMoney } from "../lib/money";
import type { CreatedOrder } from "../lib/types";

export function SuccessScreen({ order, onNewOrder }: { order: CreatedOrder; onNewOrder: () => void }): ReactNode {
  return (
    <>
      <div className="content" style={{ alignItems: "center", textAlign: "center", paddingTop: 32 }}>
        <div className="emoji-lg">✅</div>
        <div className="card-title" style={{ fontSize: 20 }}>
          تم استلام طلبك
        </div>
        <div className="muted">رقم الطلب</div>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 1 }} dir="ltr">
          {order.publicCode}
        </div>

        <div className="card" style={{ width: "100%", textAlign: "start", marginTop: 8 }}>
          <div className="summary-line">
            <span className="muted">الحالة</span>
            <span>{statusLabel(order.status)}</span>
          </div>
          <div className="summary-line">
            <span className="muted">الإجمالي</span>
            <span>
              {formatMoney(order.priceTotal)} {CURRENCY}
            </span>
          </div>
          <div className="summary-line">
            <span className="muted">المبلغ المطلوب عند الاستلام</span>
            <span>
              {formatMoney(order.codAmount)} {CURRENCY}
            </span>
          </div>
        </div>
      </div>

      <div className="cta">
        <button type="button" className="btn" onClick={onNewOrder}>
          طلب جديد
        </button>
      </div>
    </>
  );
}
