// دمج WaFlow (§24) — عميل الحملات (على نمط البث + فلتر شريحة، P2.6): إنشاء/قائمة +
// معاينة الوصول (audience-count). كل النداءات عبر /api/proxy. النص لا سعر فيه (رسائل فقط).

import { ApiError } from "./api";
import type { AudienceFilter } from "./journeys";

export type { AudienceFilter };

export interface Campaign {
  id: string;
  title: string | null;
  body: string;
  status: string;
  sentCount: number;
  failedCount: number;
  scheduledAt: string | null;
  createdAt: string;
}

async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    method,
    cache: "no-store",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export const campaigns = {
  list: (): Promise<{ broadcasts: Campaign[] }> => call("broadcasts", "GET"),
  create: (input: { body: string; title?: string; audienceFilter?: AudienceFilter }): Promise<{ broadcast: Campaign; enqueued: boolean }> =>
    call("broadcasts", "POST", input),
  audienceCount: (audienceFilter?: AudienceFilter): Promise<{ count: number }> =>
    call("broadcasts/audience-count", "POST", audienceFilter ? { audienceFilter } : {}),
};
