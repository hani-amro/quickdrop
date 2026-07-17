import { useCallback } from "react";
import type { ReactNode } from "react";
import { getRestaurants } from "../lib/api";
import { useResource } from "../lib/useResource";
import { CenteredState, Spinner } from "../components/ui";
import type { Restaurant, RestaurantsResponse } from "../lib/types";

export function RestaurantsScreen({
  apiBase,
  token,
  onPick,
}: {
  apiBase: string;
  token: string;
  onPick: (r: Restaurant) => void;
}): ReactNode {
  const fetcher = useCallback(
    (signal: AbortSignal): Promise<RestaurantsResponse> => getRestaurants(apiBase, token, signal),
    [apiBase, token],
  );
  const res = useResource(fetcher);

  if (res.status === "loading") {
    return (
      <CenteredState title="جارٍ تحميل المطاعم…">
        <Spinner />
      </CenteredState>
    );
  }
  if (res.status === "error") {
    return (
      <CenteredState emoji="⚠️" title="تعذّر التحميل" detail={res.error}>
        <button type="button" className="btn" onClick={res.reload} style={{ maxWidth: 220 }}>
          إعادة المحاولة
        </button>
      </CenteredState>
    );
  }

  const restaurants = res.data?.restaurants ?? [];
  if (restaurants.length === 0) {
    return <CenteredState emoji="🍽️" title="لا توجد مطاعم متاحة حالياً" />;
  }

  return (
    <div className="content">
      {restaurants.map((r) => (
        <button key={r.id} type="button" className="card card-tappable" onClick={() => onPick(r)}>
          <span className="item-info">
            <span className="card-title">{r.name}</span>
            <span className="muted">
              {r.prepMinutesDefault !== null ? `وقت التحضير ~ ${r.prepMinutesDefault} دقيقة` : "توصيل طعام"}
            </span>
          </span>
          <span className="chevron">‹</span>
        </button>
      ))}
    </div>
  );
}
