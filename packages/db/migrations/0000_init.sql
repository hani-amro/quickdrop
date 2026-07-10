CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"logo_url" text,
	"brand_color" text,
	"timezone" text DEFAULT 'Asia/Damascus' NOT NULL,
	"default_locale" text DEFAULT 'ar' NOT NULL,
	"currency" text DEFAULT 'SYP' NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"suspended_reason" text,
	"eta_correction_bp" integer DEFAULT 12000 NOT NULL,
	"bot_token_encrypted" "bytea",
	"bot_username" text,
	"bot_webhook_secret" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "webhook_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"update_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_updates" ADD CONSTRAINT "webhook_updates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_updates_tenant_update_uq" ON "webhook_updates" USING btree ("tenant_id","update_id");