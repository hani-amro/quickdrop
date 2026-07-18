-- دمج WaFlow (MERGE_PLAN §3.4) — Journeys: محرك الأتمتة الوحيد. RLS بنفس الملف (R-01).
CREATE TABLE "journeys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name" text NOT NULL,
  "description" text,
  "trigger" text NOT NULL,
  "audience_filter" jsonb,
  "steps" jsonb NOT NULL,
  "is_active" boolean NOT NULL DEFAULT false,
  "enrolled_count" integer NOT NULL DEFAULT 0,
  "completed_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "journeys_tenant_id_id_uq" ON "journeys" ("tenant_id", "id");--> statement-breakpoint
CREATE INDEX "journeys_tenant_trigger_active_idx" ON "journeys" ("tenant_id", "trigger", "is_active");--> statement-breakpoint
ALTER TABLE "journeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journeys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journeys"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint

CREATE TABLE "journey_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "journey_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "current_step" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'active',
  "next_run_at" timestamptz,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "journey_runs_journey_fk" FOREIGN KEY ("tenant_id", "journey_id") REFERENCES "journeys"("tenant_id", "id"),
  CONSTRAINT "journey_runs_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "journey_runs_tenant_id_id_uq" ON "journey_runs" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_runs_tenant_journey_user_uq" ON "journey_runs" ("tenant_id", "journey_id", "user_id");--> statement-breakpoint
CREATE INDEX "journey_runs_tenant_status_next_idx" ON "journey_runs" ("tenant_id", "status", "next_run_at");--> statement-breakpoint
ALTER TABLE "journey_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journey_runs"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "worker_scan" ON "journey_runs" FOR SELECT TO "app_worker" USING (true);
