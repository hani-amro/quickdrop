-- دمج WaFlow (MERGE_PLAN §4.4، قرار المالك 2026-07-19) — المخزن الموحّد للمحادثات:
-- خيط واحد لكل زبون مهما تعدّدت القنوات. RLS بنفس الملف (R-01). القناة سمة الرسالة.

CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "assigned_staff_id" uuid,
  "last_message_at" timestamptz,
  "last_message_preview" text,
  "last_inbound_at" timestamptz,
  "unread_count" integer NOT NULL DEFAULT 0,
  "ai_enabled" boolean NOT NULL DEFAULT true,
  "snoozed_until" timestamptz,
  "resolved_at" timestamptz,
  "csat_sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversations_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "conversations_staff_fk" FOREIGN KEY ("tenant_id", "assigned_staff_id") REFERENCES "staff"("tenant_id", "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_tenant_id_id_uq" ON "conversations" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_tenant_user_uq" ON "conversations" ("tenant_id", "user_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_status_last_idx" ON "conversations" ("tenant_id", "status", "last_message_at");--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint

CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "conversation_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "direction" text NOT NULL,
  "type" text NOT NULL DEFAULT 'text',
  "content" text,
  "media_url" text,
  "media_mime" text,
  "external_id" text,
  "sent_by_staff_id" uuid,
  "status" text NOT NULL DEFAULT 'sent',
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id"),
  CONSTRAINT "messages_staff_fk" FOREIGN KEY ("tenant_id", "sent_by_staff_id") REFERENCES "staff"("tenant_id", "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_tenant_id_id_uq" ON "messages" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_tenant_channel_external_uq" ON "messages" ("tenant_id", "channel", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" ("tenant_id", "conversation_id", "created_at");--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
