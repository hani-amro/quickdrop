import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./lib/api";
import { ApiError } from "./lib/api";
import { resolveConfig, stripAuthParamsFromUrl, type AppConfig } from "./lib/config";
import type { DriverOfferView, DriverOrderView, DriverProfile, DriverStatusTarget } from "./lib/types";

const TOKEN_KEY = "qd_driver_token";
const POLL_MS = 8000;

type Phase =
  | { k: "connecting" }
  | { k: "no_session"; reason: string }
  | { k: "ready"; token: string; driver: DriverProfile };

// خطوة السائق التالية لكل حالة (assigned→picked_up→in_transit→arrived→delivered).
const NEXT: Record<string, { to: DriverStatusTarget; label: string }> = {
  assigned: { to: "picked_up", label: "Picked up" },
  picked_up: { to: "in_transit", label: "Start delivery" },
  in_transit: { to: "arrived", label: "Arrived" },
  arrived: { to: "delivered", label: "Delivered" },
};
const POD_STATUSES = new Set(["picked_up", "in_transit", "arrived"]);

export function App() {
  const cfg = useRef<AppConfig>(resolveConfig()).current;
  const [phase, setPhase] = useState<Phase>({ k: "connecting" });

  const signOut = useCallback((reason: string) => {
    localStorage.removeItem(TOKEN_KEY);
    setPhase({ k: "no_session", reason });
  }, []);

  // إقلاع المصادقة: كود من الرابط → مبادلة؛ وإلا توكن مخزَّن (نتحقق بـ /me)؛ وإلا لا جلسة.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (cfg.code !== null) {
          const res = await api.authenticate(cfg.apiBase, cfg.tenantSlug, cfg.code);
          if (cancelled) return;
          localStorage.setItem(TOKEN_KEY, res.token);
          stripAuthParamsFromUrl();
          setPhase({ k: "ready", token: res.token, driver: res.driver });
          return;
        }
        const stored = localStorage.getItem(TOKEN_KEY);
        if (stored !== null) {
          const me = await api.getMe(cfg.apiBase, stored);
          if (cancelled) return;
          setPhase({ k: "ready", token: stored, driver: me.driver });
          return;
        }
        setPhase({ k: "no_session", reason: "Open the link your office sent you." });
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ApiError && e.status === 401
            ? "Your access has expired or was revoked. Ask your office for a new link."
            : "Couldn't connect. Check your internet and reopen the app.";
        localStorage.removeItem(TOKEN_KEY);
        setPhase({ k: "no_session", reason: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  if (phase.k === "connecting") return <Centered>Connecting…</Centered>;
  if (phase.k === "no_session") return <Centered>{phase.reason}</Centered>;
  return <Dashboard cfg={cfg} token={phase.token} driver={phase.driver} onSignOut={signOut} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="screen center">
      <div className="card">{children}</div>
    </div>
  );
}

function Dashboard({ cfg, token, driver, onSignOut }: { cfg: AppConfig; token: string; driver: DriverProfile; onSignOut: (r: string) => void }) {
  const [status, setStatus] = useState(driver.status);
  const [offers, setOffers] = useState<DriverOfferView[]>([]);
  const [orders, setOrders] = useState<DriverOrderView[]>([]);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);

  const guard = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onSignOut("Your access was revoked. Ask your office for a new link.");
    },
    [onSignOut],
  );

  const refresh = useCallback(async () => {
    try {
      const [o, f] = await Promise.all([api.getOrders(cfg.apiBase, token), api.getOffers(cfg.apiBase, token)]);
      setOrders(o.orders);
      setOffers(f.offers);
    } catch (e) {
      guard(e);
    }
  }, [cfg.apiBase, token, guard]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // مشاركة الموقع الحيّة: watchPosition → POST /location لكل نقطة (المصدر الوحيد للتتبع الحيّ).
  const toggleSharing = useCallback(() => {
    if (sharing) {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      setSharing(false);
      return;
    }
    if (!("geolocation" in navigator)) {
      setNote("This device has no location support.");
      return;
    }
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        void api.postLocation(cfg.apiBase, token, pos.coords.latitude, pos.coords.longitude).catch(guard);
      },
      () => setNote("Location permission denied — enable it to share your position."),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    setSharing(true);
  }, [sharing, cfg.apiBase, token, guard]);

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  const doShift = useCallback(async () => {
    try {
      const r = await api.setShift(cfg.apiBase, token, "toggle");
      setStatus(r.status);
    } catch (e) {
      guard(e);
    }
  }, [cfg.apiBase, token, guard]);

  const accept = useCallback(async (offerId: string) => {
    try {
      const r = await api.acceptOffer(cfg.apiBase, token, offerId);
      setNote(r.outcome === "accepted" ? "Order accepted." : r.outcome === "taken" ? "Another driver took it." : r.outcome === "expired" ? "Offer expired." : "Done.");
      await refresh();
    } catch (e) {
      guard(e);
    }
  }, [cfg.apiBase, token, refresh, guard]);

  const reject = useCallback(async (offerId: string) => {
    try {
      await api.rejectOffer(cfg.apiBase, token, offerId);
      await refresh();
    } catch (e) {
      guard(e);
    }
  }, [cfg.apiBase, token, refresh, guard]);

  const advance = useCallback(async (orderId: string, to: DriverStatusTarget) => {
    try {
      const r = await api.setStatus(cfg.apiBase, token, orderId, to);
      if (!r.ok) setNote(r.reason === "not_yours" ? "That order isn't assigned to you." : "Couldn't update — refresh and retry.");
      await refresh();
    } catch (e) {
      guard(e);
    }
  }, [cfg.apiBase, token, refresh, guard]);

  const uploadPod = useCallback(async (file: File) => {
    try {
      const b64 = await fileToBase64(file);
      const r = await api.postPod(cfg.apiBase, token, b64);
      setNote(r.outcome === "stored" ? `Delivery photo saved for #${r.publicCode ?? ""}.` : r.outcome === "no_active_order" ? "No active order for a photo." : "Photo rejected — try a clearer JPG/PNG.");
    } catch (e) {
      guard(e);
    }
  }, [cfg.apiBase, token, guard]);

  const online = status === "online";
  return (
    <div className="screen">
      <header className="topbar">
        <div>
          <div className="hi">Hi, {driver.name ?? "driver"}</div>
          <div className={`dot ${online ? "on" : "off"}`}>{online ? "On shift" : "Off shift"}</div>
        </div>
        <button className={`btn ${online ? "ghost" : "primary"}`} onClick={() => void doShift()}>
          {online ? "End shift" : "Go online"}
        </button>
      </header>

      <button className={`btn wide ${sharing ? "ghost" : "primary"}`} onClick={toggleSharing}>
        {sharing ? "◉ Sharing location — tap to stop" : "Share my location"}
      </button>
      {note !== null && <div className="note" onClick={() => setNote(null)}>{note}</div>}

      {offers.length > 0 && (
        <section>
          <h2>New offers</h2>
          {offers.map((o) => (
            <div key={o.offerId} className="card">
              <div className="row"><b>#{o.publicCode}</b><span>{o.priceTotal}</span></div>
              <div className="muted">Pickup: {o.pickupText ?? mapLink(o.pickupLat, o.pickupLng)}</div>
              <div className="muted">Drop: {o.dropoffText ?? mapLink(o.dropoffLat, o.dropoffLng)}</div>
              <div className="row">
                <button className="btn primary" onClick={() => void accept(o.offerId)}>Accept</button>
                <button className="btn ghost" onClick={() => void reject(o.offerId)}>Reject</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>My deliveries</h2>
        {orders.length === 0 && <div className="muted card">No active deliveries.</div>}
        {orders.map((o) => {
          const next = NEXT[o.status];
          return (
            <div key={o.id} className="card">
              <div className="row"><b>#{o.publicCode}</b><span className="pill">{o.status.replace(/_/g, " ")}</span></div>
              <div className="muted">Pickup: {o.pickupText ?? ""} <a href={geoUrl(o.pickupLat, o.pickupLng)} target="_blank" rel="noreferrer">map</a></div>
              <div className="muted">Drop: {o.dropoffText ?? ""} <a href={geoUrl(o.dropoffLat, o.dropoffLng)} target="_blank" rel="noreferrer">map</a></div>
              {BigInt(o.codAmount) > 0n && <div className="cod">Collect cash: {o.codAmount}</div>}
              <div className="row">
                {next && <button className="btn primary" onClick={() => void advance(o.id, next.to)}>{next.label}</button>}
                <button className="btn ghost" onClick={() => void advance(o.id, "failed")}>Can't deliver</button>
              </div>
              {POD_STATUSES.has(o.status) && (
                <label className="pod">
                  Add delivery photo
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPod(f); e.target.value = ""; }} />
                </label>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function mapLink(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function geoUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s); // نزع بادئة data:...;base64,
    };
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}
