import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { resolveConfig } from "./lib/config";
import { applyTelegramTheme, getWebApp, hasInitData, initTelegram } from "./lib/telegram";
import { useAuth } from "./lib/useAuth";
import { cartCount } from "./lib/cart";
import type { Cart } from "./lib/cart";
import type { CatalogItem, CreatedOrder, Restaurant } from "./lib/types";
import { CenteredState, Spinner, TopBar } from "./components/ui";
import { TelegramGate } from "./components/TelegramGate";
import { RestaurantsScreen } from "./screens/RestaurantsScreen";
import { MenuScreen } from "./screens/MenuScreen";
import { DropoffScreen } from "./screens/DropoffScreen";
import type { DropoffValue } from "./screens/DropoffScreen";
import { ConfirmScreen } from "./screens/ConfirmScreen";
import { SuccessScreen } from "./screens/SuccessScreen";

type ScreenName = "restaurants" | "menu" | "dropoff" | "confirm" | "success";

const EMPTY_DROPOFF: DropoffValue = { point: null, text: "" };

export function App(): ReactNode {
  const config = useMemo(resolveConfig, []);

  // §10.3 — ready()/expand() + تطبيق ثيم تيليغرام، والاستماع لتغيّر الثيم.
  useEffect(() => {
    initTelegram();
    applyTelegramTheme();
    const wa = getWebApp();
    if (wa === null) return;
    wa.onEvent("themeChanged", applyTelegramTheme);
    return () => wa.offEvent("themeChanged", applyTelegramTheme);
  }, []);

  // خارج تيليغرام (لا initData): بوابة إرشاد، لا توثيق ملفّق.
  if (!hasInitData()) return <TelegramGate />;

  return <AuthedApp config={config} />;
}

function AuthedApp({ config }: { config: ReturnType<typeof resolveConfig> }): ReactNode {
  const auth = useAuth(config);

  if (auth.status === "loading") {
    return (
      <div className="app">
        <CenteredState title="جارٍ تسجيل الدخول…">
          <Spinner />
        </CenteredState>
      </div>
    );
  }

  if (auth.status === "error" || auth.token === null) {
    return (
      <div className="app">
        <CenteredState emoji="⚠️" title="تعذّر تسجيل الدخول" detail={auth.error ?? "خطأ غير متوقع"}>
          <button type="button" className="btn" onClick={auth.retry} style={{ maxWidth: 220 }}>
            إعادة المحاولة
          </button>
        </CenteredState>
      </div>
    );
  }

  return (
    <Shop
      apiBase={config.apiBase}
      token={auth.token}
      reauth={auth.reauth}
      greeting={auth.user?.firstName ?? ""}
    />
  );
}

function Shop({
  apiBase,
  token,
  reauth,
  greeting,
}: {
  apiBase: string;
  token: string;
  reauth: () => Promise<string>;
  greeting: string;
}): ReactNode {
  const [screen, setScreen] = useState<ScreenName>("restaurants");
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [dropoff, setDropoff] = useState<DropoffValue>(EMPTY_DROPOFF);
  const [order, setOrder] = useState<CreatedOrder | null>(null);

  const pickRestaurant = (r: Restaurant): void => {
    setRestaurant((prev) => {
      if (prev?.id !== r.id) setCart({}); // تبديل المطعم يُفرغ السلة
      return r;
    });
    setScreen("menu");
  };

  const setQty = (item: CatalogItem, qty: number): void => {
    setCart((prev) => {
      const next: Cart = { ...prev };
      if (qty <= 0) {
        delete next[item.id];
      } else {
        next[item.id] = { itemId: item.id, nameAr: item.nameAr, price: item.price, qty };
      }
      return next;
    });
  };

  const resetAll = (): void => {
    setScreen("restaurants");
    setRestaurant(null);
    setCart({});
    setDropoff(EMPTY_DROPOFF);
    setOrder(null);
  };

  // شاشة النجاح: بلا شريط علوي/رجوع
  if (screen === "success" && order !== null) {
    return (
      <div className="app">
        <SuccessScreen order={order} onNewOrder={resetAll} />
      </div>
    );
  }

  const count = cartCount(cart);

  let title = "المطاعم";
  let onBack: (() => void) | undefined;
  if (screen === "menu") {
    title = restaurant?.name ?? "القائمة";
    onBack = () => setScreen("restaurants");
  } else if (screen === "dropoff") {
    title = "موقع التسليم";
    onBack = () => setScreen("menu");
  } else if (screen === "confirm") {
    title = "تأكيد الطلب";
    onBack = () => setScreen("dropoff");
  }

  return (
    <div className="app">
      <TopBar
        title={title}
        {...(onBack !== undefined ? { onBack } : {})}
        right={
          screen === "restaurants" && greeting.length > 0 ? (
            <span className="muted">أهلاً {greeting}</span>
          ) : count > 0 && screen === "menu" ? (
            <span className="cart-badge">{count}</span>
          ) : undefined
        }
      />

      {screen === "restaurants" ? (
        <RestaurantsScreen apiBase={apiBase} token={token} onPick={pickRestaurant} />
      ) : null}

      {screen === "menu" && restaurant !== null ? (
        <MenuScreen
          apiBase={apiBase}
          token={token}
          restaurant={restaurant}
          cart={cart}
          onSetQty={setQty}
          onContinue={() => setScreen("dropoff")}
        />
      ) : null}

      {screen === "dropoff" ? (
        <DropoffScreen value={dropoff} onChange={setDropoff} onContinue={() => setScreen("confirm")} />
      ) : null}

      {screen === "confirm" && restaurant !== null ? (
        <ConfirmScreen
          apiBase={apiBase}
          token={token}
          reauth={reauth}
          restaurant={restaurant}
          cart={cart}
          dropoff={dropoff}
          onPlaced={(placed) => {
            setOrder(placed);
            setScreen("success");
          }}
        />
      ) : null}
    </div>
  );
}
