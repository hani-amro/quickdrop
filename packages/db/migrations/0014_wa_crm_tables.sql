-- دمج WaFlow — Phase 1 (MERGE_PLAN §4.3/§4.5): جداول قناة واتساب ودماغ الزبون.
-- القاعدة الصارمة (R-01): الجدول + RLS بنفس الترحيل — لا نافذة انجراف (سابقة 0010).

-- (أ) مفتاح توجيه واتساب على جدول التوجيه (نفس سابقة slug — ليس سراً):
ALTER TABLE "tenants" ADD COLUMN "wa_phone_number_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_wa_phone_number_id_uq" ON "tenants" ("wa_phone_number_id")
  WHERE "wa_phone_number_id" IS NOT NULL;--> statement-breakpoint

-- (ب) wa_accounts — أسرار/إعدادات القناة، تحت FORCE RLS، التوكن bytea مشفّر (0013 نمطاً):
CREATE TABLE "wa_accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "phone_number_id" text NOT NULL,
  "phone_number" text,
  "access_token_enc" bytea,
  "waba_id" text,
  "campaign_template_name" text,
  "campaign_template_lang" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "wa_accounts_tenant_id_id_uq" ON "wa_accounts" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_accounts_tenant_uq" ON "wa_accounts" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_accounts_phone_number_id_uq" ON "wa_accounts" ("phone_number_id");--> statement-breakpoint
ALTER TABLE "wa_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wa_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wa_accounts"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint

-- (ج) wa_webhook_updates — inbox durable (نمط webhook_updates حرفياً، R-12):
CREATE TABLE "wa_webhook_updates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "event_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'received',
  "received_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "wa_webhook_updates_tenant_event_uq" ON "wa_webhook_updates" ("tenant_id", "event_key");--> statement-breakpoint
CREATE INDEX "wa_webhook_updates_tenant_status_idx" ON "wa_webhook_updates" ("tenant_id", "status");--> statement-breakpoint
ALTER TABLE "wa_webhook_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wa_webhook_updates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wa_webhook_updates"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- إعادة بناء الفائت عند إقلاع الـ worker (§12) — مسح عابر بقراءة مسمّاة كنمط webhook_updates:
CREATE POLICY "worker_scan" ON "wa_webhook_updates" FOR SELECT TO "app_worker" USING (true);--> statement-breakpoint

-- (د) customer_profiles — ملف CRM المشتق (D-M2؛ الهوية تبقى users):
CREATE TABLE "customer_profiles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL,
  "lifecycle_stage" text NOT NULL DEFAULT 'new',
  "rfm_score" integer NOT NULL DEFAULT 0,
  "order_count" integer NOT NULL DEFAULT 0,
  "total_spent" bigint NOT NULL DEFAULT 0,
  "avg_order_amount" bigint NOT NULL DEFAULT 0,
  "last_order_at" timestamptz,
  "favorite_items" jsonb,
  "churn_risk_at" timestamptz,
  "brain_computed_at" timestamptz,
  "tags" text[] NOT NULL DEFAULT '{}'::text[],
  "referral_code" text,
  "avatar_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customer_profiles_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_tenant_id_id_uq" ON "customer_profiles" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_tenant_user_uq" ON "customer_profiles" ("tenant_id", "user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_tenant_referral_uq" ON "customer_profiles" ("tenant_id", "referral_code")
  WHERE "referral_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_profiles_tenant_lifecycle_idx" ON "customer_profiles" ("tenant_id", "lifecycle_stage");--> statement-breakpoint
CREATE INDEX "customer_profiles_tenant_last_order_idx" ON "customer_profiles" ("tenant_id", "last_order_at");--> statement-breakpoint
ALTER TABLE "customer_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_profiles"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint

-- (هـ) customer_facts — ذاكرة AI (confidence عدد صحيح مئوي — كان Float بـ WaFlow):
CREATE TABLE "customer_facts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL,
  "key" text NOT NULL,
  "value" text NOT NULL,
  "source" text NOT NULL DEFAULT 'ai',
  "confidence" integer NOT NULL DEFAULT 70,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customer_facts_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "customer_facts_confidence_ck" CHECK ("confidence" BETWEEN 0 AND 100)
);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_facts_tenant_id_id_uq" ON "customer_facts" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_facts_tenant_user_key_uq" ON "customer_facts" ("tenant_id", "user_id", "key");--> statement-breakpoint
ALTER TABLE "customer_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_facts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_facts"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
