export interface AppConfig {
  apiBase: string;
  tenantSlug: string;
}

// السلَگ وعنوان الـ API من متغيرات Vite، مع تجاوز ?tenant=<slug> في الرابط (له الأسبقية).
export function resolveConfig(): AppConfig {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("tenant");
  const tenantSlug =
    override !== null && override.trim().length > 0
      ? override.trim()
      : import.meta.env.VITE_TENANT_SLUG ?? "demo";
  const rawBase = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";
  const apiBase = rawBase.replace(/\/+$/, ""); // بلا / زائدة في النهاية
  return { apiBase, tenantSlug };
}
