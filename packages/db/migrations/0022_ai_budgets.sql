-- دمج WaFlow (MERGE_PLAN §3.2 / R-18) — ميزانية وكيل الـ AI لكل مستأجر:
-- إنفاق ذرّي بشرط السقف (UPDATE شرطي واحد — يقتل سباق check-then-act الذي كان بـ WaFlow)،
-- بأعداد صحيحة (سنتات MYR — D5). صف واحد لكل مستأجر؛ period 'YYYY-MM' يتصفّر ذرّياً
-- عند أول إنفاق بشهر جديد. لا صف = الوكيل معطّل للمستأجر (لا افتراضي مفتوح).

CREATE TABLE "ai_budgets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "monthly_budget_sen" bigint NOT NULL DEFAULT 0,
  "spent_sen" bigint NOT NULL DEFAULT 0,
  "period" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_budgets_nonneg_ck" CHECK ("monthly_budget_sen" >= 0 AND "spent_sen" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_budgets_tenant_uq" ON "ai_budgets" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_budgets_tenant_id_id_uq" ON "ai_budgets" ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "ai_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_budgets"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
