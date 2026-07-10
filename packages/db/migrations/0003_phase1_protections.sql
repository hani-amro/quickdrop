-- §2.2/§2.3/§8 — حمايات المرحلة 1: RLS مُجبَر على كل جدول أعمال + سياسات worker
-- + append-only + قيود CHECK المالية. الاستثناءات المسمّاة: tenants, admin_users,
-- tenant_payments, tracking_tokens (v1.1 §2.3).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','addresses','merchants','catalog_items','drivers','driver_locations',
    'zones','pricing_rules','orders','order_items','order_events','offers',
    'order_attachments','ledger_entries','settlements','loyalty_accounts',
    'loyalty_events','coupons','coupon_redemptions','referrals','staff',
    'audit_log','support_threads','support_messages','broadcasts','outbox'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;--> statement-breakpoint

-- §2.3 v1.1 — المهام العابرة للمستأجرين: app_worker يلتقط قراءةً فقط، والمعالجة withTenant
CREATE POLICY "worker_scan" ON "outbox" FOR SELECT TO "app_worker" USING (true);--> statement-breakpoint
CREATE POLICY "worker_scan" ON "orders" FOR SELECT TO "app_worker" USING (true);--> statement-breakpoint

-- §16.14 — append-only تقنياً لا تعليمات: trigger يمنع UPDATE/DELETE
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only (corrections are new reversing rows)', TG_TABLE_NAME;
END $fn$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER loyalty_events_append_only BEFORE UPDATE OR DELETE ON loyalty_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- ledger_entries: الاستثناء الوحيد المسموح تعديله = ربط settlement_id عند التسوية (§8.2)؛
-- كل ما عداه append-only، والحذف ممنوع نهائياً
CREATE FUNCTION ledger_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only (corrections are new reversing rows)';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.driver_id, NEW.order_id, NEW.entry_type,
         NEW.amount, NEW.memo, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.driver_id, OLD.order_id, OLD.entry_type,
         OLD.amount, OLD.memo, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'ledger_entries: only settlement_id may be set after insert (§8.2)';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER ledger_entries_guard BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_guard();--> statement-breakpoint

REVOKE UPDATE, DELETE ON order_events, audit_log, loyalty_events FROM app_user, app_worker;--> statement-breakpoint
REVOKE DELETE ON ledger_entries FROM app_user, app_worker;--> statement-breakpoint

-- §8.3-1 — معادلة السعر الكاملة (v1.1) كـ CHECK، وكل المكوّنات NOT NULL أصلاً
ALTER TABLE orders ADD CONSTRAINT orders_price_equation_ck CHECK (
  price_total = price_base + price_distance + price_weight + price_surge
              + price_min_adjustment - price_discount
);--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_amounts_nonnegative_ck CHECK (
  price_total >= 0 AND cod_amount >= 0 AND goods_amount >= 0
  AND (cod_received IS NULL OR cod_received >= 0)
);--> statement-breakpoint
ALTER TABLE order_items ADD CONSTRAINT order_items_qty_positive_ck CHECK (qty > 0);--> statement-breakpoint

-- §8.1 v1.1 — إشارة كل نوع قيد مفروضة: المنظور موجب = بذمة السائق للمكتب
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_sign_ck CHECK (
  (entry_type = 'cod_collected' AND amount > 0)
  OR (entry_type IN ('goods_paid_by_driver','delivery_fee_earned','remitted','payout') AND amount < 0)
  OR (entry_type = 'adjustment' AND amount <> 0)
);--> statement-breakpoint

-- audit_log: أحد الفاعلين إلزامي (v1.1 §3)
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_ck CHECK (
  actor_staff_id IS NOT NULL OR actor_admin_id IS NOT NULL
);
