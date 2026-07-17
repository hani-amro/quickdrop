import { useEffect, useRef } from "react";

// وصول آمن لـ window.Telegram.WebApp + تطبيق ثيم تيليغرام على متغيّرات CSS.
export function getWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

// initData فارغ = خارج تيليغرام (متصفح عادي). لا نُلفّق initData أبداً (§10.3).
export function hasInitData(): boolean {
  const wa = getWebApp();
  return typeof wa?.initData === "string" && wa.initData.length > 0;
}

// نداء ready()/expand() عند الإقلاع — يُخبر تيليغرام أن الواجهة جاهزة ويوسّع النافذة.
export function initTelegram(): void {
  const wa = getWebApp();
  if (wa === null) return;
  try {
    wa.ready();
    wa.expand();
  } catch {
    // بعض إصدارات SDK القديمة قد لا تدعم expand — لا نُسقط الواجهة
  }
}

export function applyTelegramTheme(): void {
  const root = document.documentElement;
  const wa = getWebApp();
  const tp: TelegramThemeParams = wa?.themeParams ?? {};
  const set = (name: string, value: string | undefined, fallback: string): void => {
    root.style.setProperty(name, value !== undefined && value.length > 0 ? value : fallback);
  };
  set("--tg-bg", tp.bg_color, "#ffffff");
  set("--tg-text", tp.text_color, "#0f1419");
  set("--tg-hint", tp.hint_color, "#8a8a8e");
  set("--tg-link", tp.link_color, "#2481cc");
  set("--tg-button", tp.button_color, "#2481cc");
  set("--tg-button-text", tp.button_text_color, "#ffffff");
  set("--tg-secondary-bg", tp.secondary_bg_color, "#f2f3f5");
  set("--tg-section-bg", tp.section_bg_color, "#ffffff");
  set("--tg-destructive", tp.destructive_text_color, "#e53935");
  root.dataset["theme"] = wa?.colorScheme === "dark" ? "dark" : "light";
}

export interface MainButtonState {
  text: string;
  visible: boolean;
  enabled: boolean;
  progress: boolean;
  onClick: () => void;
}

/**
 * يقود MainButton الخاص بتيليغرام كـ CTA رئيسي. no-op بلا ضرر خارج تيليغرام
 * (الواجهة تُبقي زر CTA داخل الصفحة أيضاً). يُنظّف onClick/hide عند التفكيك.
 */
export function useMainButton(state: MainButtonState): void {
  const handlerRef = useRef(state.onClick);
  handlerRef.current = state.onClick;

  useEffect(() => {
    const mb = getWebApp()?.MainButton;
    if (mb === undefined) return;
    const cb = (): void => handlerRef.current();
    mb.onClick(cb);
    return () => {
      mb.offClick(cb);
      mb.hide();
    };
  }, []);

  useEffect(() => {
    const mb = getWebApp()?.MainButton;
    if (mb === undefined) return;
    mb.setText(state.text);
    if (state.enabled) mb.enable();
    else mb.disable();
    if (state.progress) mb.showProgress();
    else mb.hideProgress();
    if (state.visible) mb.show();
    else mb.hide();
  }, [state.text, state.visible, state.enabled, state.progress]);
}
