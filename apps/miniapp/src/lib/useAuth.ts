import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, authenticate } from "./api";
import { errorMessage } from "./format";
import { getWebApp } from "./telegram";
import type { AppConfig } from "./config";
import type { AuthUser } from "./types";

export type AuthStatus = "loading" | "ready" | "error";

export interface AuthState {
  status: AuthStatus;
  token: string | null;
  user: AuthUser | null;
  error: string | null;
  retry: () => void;
  /** يُعيد التوثيق ويُرجع رمزاً جديداً (لإعادة محاولة 401 في POST /orders). */
  reauth: () => Promise<string>;
}

// §10.3 — إقلاع التوثيق: POST /auth بـ initData الوارد من تيليغرام. الرمز في الذاكرة فقط.
export function useAuth(config: AppConfig): AuthState {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    const wa = getWebApp();
    const initData = wa?.initData ?? "";
    if (initData.length === 0) {
      setStatus("error");
      setError("يجب فتح التطبيق من داخل تيليغرام");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const res = await authenticate(config.apiBase, config.tenantSlug, initData);
      setToken(res.token);
      setUser(res.user);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof ApiError && err.status === 401
          ? "بيانات الدخول غير صالحة أو منتهية — أعد فتح التطبيق من تيليغرام"
          : errorMessage(err),
      );
    }
  }, [config]);

  useEffect(() => {
    if (startedRef.current) return; // حارس StrictMode: لا توثيق مزدوج
    startedRef.current = true;
    void run();
  }, [run]);

  const reauth = useCallback(async (): Promise<string> => {
    const wa = getWebApp();
    const initData = wa?.initData ?? "";
    if (initData.length === 0) throw new ApiError(401, "no-initdata");
    const res = await authenticate(config.apiBase, config.tenantSlug, initData);
    setToken(res.token);
    setUser(res.user);
    return res.token;
  }, [config]);

  const retry = useCallback((): void => {
    void run();
  }, [run]);

  return { status, token, user, error, retry, reauth };
}
