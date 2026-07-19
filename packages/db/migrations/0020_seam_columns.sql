-- دمج WaFlow (MERGE_PLAN §4.1/§4.2، Phase 3) — أعمدة المفصل والدفع على orders +
-- توقيت seam لكل مستأجر. لا حالات جديدة بالقاعدة (status عمود text — الاتحاد بالكود).
-- ملاحظة تسلسل: نقاط pickup/dropoff تبقى NOT NULL — جعلها NULLable يهبط مع استيراد
-- بيانات WaFlow بـ Phase 5 (لا مسار إنشاء ينتج طلباً بلا نقاط الآن).

ALTER TABLE "orders" ADD COLUMN "fulfillment" text NOT NULL DEFAULT 'delivery';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ready_at" timestamptz;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dispatch_requested_at" timestamptz;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "goods_tax" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_status" text NOT NULL DEFAULT 'unpaid';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_ref" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_paid_at" timestamptz;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source" text;--> statement-breakpoint

-- CHECKs خفيفة (قيم enum بالكود؛ القاعدة تصدّ القيم الغريبة — §16.2)
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfillment_check" CHECK ("fulfillment" IN ('delivery','pickup'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_check" CHECK ("payment_status" IN ('unpaid','paid'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_goods_tax_nonneg_check" CHECK ("goods_tax" >= 0);--> statement-breakpoint

-- خيط المحادثة الذي وُلد منه الطلب (Brain A) — FK مركّب + فهرس [adversary #16].
-- NOT VALID بلا VALIDATE (نمط 0010): الصفوف الجديدة تُفحص؛ مسح الصفوف القائمة يصطدم
-- بـ FORCE RLS على conversations (سياسة current_setting بلا سياق للمُرحِّل — 42704)،
-- والعمود جديد كله NULL فلا شيء يُتحقّق منه أصلاً.
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_fk"
  FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") NOT VALID;--> statement-breakpoint
CREATE INDEX "orders_tenant_conversation_idx" ON "orders" ("tenant_id", "conversation_id");--> statement-breakpoint

-- مرجع الدفع: بحث webhook بالبوابة يكون بالمرجع — فهرس جزئي ضمن المستأجر
CREATE INDEX "orders_tenant_payment_ref_idx" ON "orders" ("tenant_id", "payment_ref") WHERE "payment_ref" IS NOT NULL;--> statement-breakpoint

-- §4.2.3 — توقيت seam الطعام لكل مستأجر
ALTER TABLE "tenants" ADD COLUMN "dispatch_trigger" text NOT NULL DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_dispatch_trigger_check" CHECK ("dispatch_trigger" IN ('ready','confirmed'));
