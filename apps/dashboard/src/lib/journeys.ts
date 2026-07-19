// دمج WaFlow (§24) — عميل الرحلات (محرك الأتمتة الوحيد، P2.5): CRUD عبر /api/proxy.
// المُطلِّق من allowlist الخادم (JOURNEY_TRIGGERS)؛ الخطوات اتحاد مميَّز. لا DB بالواجهة.

import { ApiError } from "./api";

export const JOURNEY_TRIGGERS = ["contact.created", "order.delivered", "payment.paid", "crm.lifecycle_changed"] as const;
export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];

export type JourneyStep =
  | { type: "send_message"; delayHours: number; template: string }
  | { type: "ai_handoff"; delayHours: number }
  | { type: "add_tag"; delayHours: number; tag: string }
  | { type: "wait"; delayHours: number };

export interface AudienceFilter {
  lifecycleStage?: string[];
  minRfm?: number;
  tags?: string[];
}

export interface Journey {
  id: string;
  name: string;
  description: string | null;
  trigger: JourneyTrigger;
  audienceFilter: AudienceFilter | null;
  steps: JourneyStep[];
  isActive: boolean;
  enrolledCount: number;
  completedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJourneyInput {
  name: string;
  description?: string;
  trigger: JourneyTrigger;
  audienceFilter?: AudienceFilter;
  steps: JourneyStep[];
  isActive?: boolean;
}

export type UpdateJourneyPatch = Partial<Pick<Journey, "name" | "description" | "isActive">> & {
  audienceFilter?: AudienceFilter | null;
  steps?: JourneyStep[];
};

async function call<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    method,
    cache: "no-store",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export const journeys = {
  list: (): Promise<{ journeys: Journey[] }> => call("journeys", "GET"),
  create: (journey: CreateJourneyInput): Promise<{ journey: Journey }> => call("journeys", "POST", { journey }),
  update: (id: string, patch: UpdateJourneyPatch): Promise<{ journey: Journey }> => call(`journeys/${id}`, "PATCH", { patch }),
  remove: (id: string): Promise<{ deleted: boolean }> => call(`journeys/${id}`, "DELETE"),
};
