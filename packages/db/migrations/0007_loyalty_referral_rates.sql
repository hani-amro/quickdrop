ALTER TABLE "tenants" ADD COLUMN "loyalty_points_per_order" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "referral_bonus_points" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "referral_monthly_cap" integer DEFAULT 5 NOT NULL;