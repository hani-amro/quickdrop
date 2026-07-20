export interface AppConfig {
  apiBase: string;
  tenantSlug: string;
  /** كود الربط من رابط المكتب (deep-link ?code=...) — يُبادَل بجلسة سائق ثم يُمسح من الرابط. */
  code: string | null;
}

// P5.1 — الإعداد من متغيّرات Vite + تجاوزات الرابط: ?tenant=<slug> و?code=<deeplink code>.
// السلَگ يحدّد المستأجر للمصادقة فقط؛ كل البيانات لاحقاً من جلسة التوكن (لا اختيار مستأجر
// من العميل بعد الدخول — نفس عزل الـ miniapp).
export function resolveConfig(): AppConfig {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("tenant");
  const tenantSlug =
    override !== null && override.trim().length > 0 ? override.trim() : import.meta.env.VITE_TENANT_SLUG ?? "demo";
  const rawBase = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";
  const apiBase = rawBase.replace(/\/+$/, "");
  const code = params.get("code");
  return { apiBase, tenantSlug, code: code !== null && code.trim().length > 0 ? code.trim() : null };
}

/** يمسح code/tenant من شريط العنوان بعد المبادلة (كي لا يبقى كود لمرة واحدة بالسجل/المشاركة). */
export function stripAuthParamsFromUrl(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["code", "tenant"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
