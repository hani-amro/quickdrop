// تصريح مُحيطي لـ window.Telegram.WebApp — لا حزمة npm للأنواع لـ Mini App SDK.
// نُصرّح فقط ما نستعمله فعلاً (§10.3): initData، الثيم، MainButton.
export {};

declare global {
  interface TelegramWebAppUser {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    photo_url?: string;
  }

  interface TelegramWebAppInitDataUnsafe {
    query_id?: string;
    user?: TelegramWebAppUser;
    auth_date?: number;
    hash?: string;
    start_param?: string;
  }

  interface TelegramThemeParams {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    link_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
    header_bg_color?: string;
    accent_text_color?: string;
    section_bg_color?: string;
    destructive_text_color?: string;
  }

  interface TelegramMainButton {
    text: string;
    color: string;
    textColor: string;
    isVisible: boolean;
    isActive: boolean;
    isProgressVisible: boolean;
    setText(text: string): TelegramMainButton;
    onClick(cb: () => void): TelegramMainButton;
    offClick(cb: () => void): TelegramMainButton;
    show(): TelegramMainButton;
    hide(): TelegramMainButton;
    enable(): TelegramMainButton;
    disable(): TelegramMainButton;
    showProgress(leaveActive?: boolean): TelegramMainButton;
    hideProgress(): TelegramMainButton;
  }

  interface TelegramWebApp {
    initData: string;
    initDataUnsafe: TelegramWebAppInitDataUnsafe;
    themeParams: TelegramThemeParams;
    colorScheme: "light" | "dark";
    version: string;
    platform: string;
    isExpanded: boolean;
    viewportHeight: number;
    MainButton: TelegramMainButton;
    ready(): void;
    expand(): void;
    close(): void;
    onEvent(event: string, handler: () => void): void;
    offEvent(event: string, handler: () => void): void;
  }

  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}
