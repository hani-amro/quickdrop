-- دمج WaFlow (MERGE_PLAN جدول التعارضات #13) — توحيد إعداد الولاء: نموذج WaFlow
-- (نقاط لكل وحدة عملة + معدّل استبدال) بأعداد صحيحة basis points بدل Float RM.
-- 0 = معطّل (النموذج الافتراضي يبقى loyalty_points_per_order). التحويل من WaFlow:
-- round(pointsPerRM*10000)، round(redeemRate*10000). لا FK، لا RLS خاص (على tenants).
ALTER TABLE "tenants" ADD COLUMN "loyalty_points_per_currency_unit_bp" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "loyalty_redeem_rate_bp" integer NOT NULL DEFAULT 0;
