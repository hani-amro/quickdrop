import { createHmac } from "node:crypto";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

// مثل outbox-poller.test: نستبدل @quickdrop/db بجداول بناء استعلام + withTenant تمريري —
// اختبار منطق البوابة بلا قاعدة حية (المسار الحي يغطيه اختبار العزل المولَّد + Phase 2).
vi.mock("@quickdrop/db", async () => {
  const { jsonb, pgTable, text, timestamp, uuid } = await import("drizzle-orm/pg-core");
  const tenants = pgTable("tenants", {
    id: uuid("id").primaryKey(),
    status: text("status").notNull(),
    waPhoneNumberId: text("wa_phone_number_id"),
  });
  const waWebhookUpdates = pgTable("wa_webhook_updates", {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    eventKey: text("event_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }),
  });
  const withTenant = async <T>(
    db: { tx: unknown },
    _tenantId: string,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => fn(db.tx);
  return { tenants, waWebhookUpdates, withTenant };
});

import type { DbHandle } from "@quickdrop/db";
import type { ApiEnv } from "../env.js";
import { WaGatewayService } from "./wa-gateway.service.js";

const SECRET = "meta-app-secret-16chars";
const TENANT = "11111111-1111-4111-8111-111111111111";

const SAMPLE = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PNID-1" },
            messages: [{ id: "wamid.in1", from: "60198765432", type: "text" }],
            statuses: [{ id: "wamid.out9", status: "delivered" }],
          },
        },
      ],
    },
  ],
};

interface FakeParts {
  service: WaGatewayService;
  queueAdd: ReturnType<typeof vi.fn>;
  insertedValues: () => unknown[];
}

function makeService(opts: {
  tenantRow?: { id: string; status: string } | undefined;
  insertReturns?: { id: string }[];
  stuckReturns?: { id: string }[];
  env?: Partial<ApiEnv>;
}): FakeParts {
  // select من tenants (توجيه) أو من tx (صفوف received العالقة)
  const tenantSelect = {
    from: vi.fn(() => tenantSelect),
    where: vi.fn(() => tenantSelect),
    limit: vi.fn(() => Promise.resolve(opts.tenantRow ? [opts.tenantRow] : [])),
  };
  const capturedInserts: unknown[] = [];
  const returning = vi.fn(() => Promise.resolve(opts.insertReturns ?? []));
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn((v: unknown) => {
    capturedInserts.push(v);
    return { onConflictDoNothing };
  });
  const stuckSelect = {
    from: vi.fn(() => stuckSelect),
    where: vi.fn(() => Promise.resolve(opts.stuckReturns ?? [])),
  };
  const tx = { insert: vi.fn(() => ({ values })), select: vi.fn(() => stuckSelect) };
  const db = { select: vi.fn(() => tenantSelect), tx } as unknown as DbHandle["db"];
  const queueAdd = vi.fn(() => Promise.resolve());
  const env = { META_APP_SECRET: SECRET, META_VERIFY_TOKEN: "verify-token-16chars", ...opts.env } as ApiEnv;
  const service = new WaGatewayService(
    { db } as DbHandle,
    { add: queueAdd } as unknown as Queue,
    env,
  );
  return { service, queueAdd, insertedValues: () => capturedInserts };
}

function signed(body: unknown): { raw: Buffer; sig: string; parsed: unknown } {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, sig: "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex"), parsed: body };
}

describe("WaGatewayService.verifySubscription (GET hub.challenge)", () => {
  it("توكن صحيح → يعيد الـ challenge حرفياً؛ خاطئ/ناقص → null", () => {
    const { service } = makeService({});
    expect(service.verifySubscription("subscribe", "verify-token-16chars", "ch-123")).toBe("ch-123");
    expect(service.verifySubscription("subscribe", "WRONG", "ch-123")).toBeNull();
    expect(service.verifySubscription("unsubscribe", "verify-token-16chars", "ch-123")).toBeNull();
  });

  it("قناة غير مهيأة (بلا META_VERIFY_TOKEN) → رفض دائم", () => {
    const { service } = makeService({ env: { META_VERIFY_TOKEN: undefined } });
    expect(service.verifySubscription("subscribe", "anything", "ch")).toBeNull();
  });
});

describe("WaGatewayService.ingest (R-12 — الحفظ durable ثم 200 ثم طابور)", () => {
  it("توقيع فاسد → invalid_signature ولا شيء يُحفظ أو يُدفع", async () => {
    const f = makeService({ tenantRow: { id: TENANT, status: "active" } });
    const { raw, parsed } = signed(SAMPLE);
    const r = await f.service.ingest(raw, "sha256=" + "0".repeat(64), parsed);
    expect(r.outcome).toBe("invalid_signature");
    expect(f.insertedValues()).toHaveLength(0);
    expect(f.queueAdd).not.toHaveBeenCalled();
  });

  it("حمولة موقعة سليمة → صفا inbox (رسالة + حالة) ودفع للطابور بـ jobId بلا ':'", async () => {
    const f = makeService({
      tenantRow: { id: TENANT, status: "active" },
      insertReturns: [{ id: "row-msg" }, { id: "row-status" }],
    });
    const { raw, sig, parsed } = signed(SAMPLE);
    const r = await f.service.ingest(raw, sig, parsed);
    expect(r).toEqual({ outcome: "accepted", enqueued: 2 });

    const values = f.insertedValues()[0] as { eventKey: string; tenantId: string }[];
    expect(values.map((v) => v.eventKey)).toEqual(["wamid.in1", "status:wamid.out9:delivered"]);
    expect(values.every((v) => v.tenantId === TENANT)).toBe(true);

    expect(f.queueAdd).toHaveBeenCalledTimes(2);
    for (const call of f.queueAdd.mock.calls as unknown as [string, unknown, { jobId: string }][]) {
      expect(call[2].jobId).not.toContain(":"); // قيد BullMQ
      expect(call[2].jobId.startsWith("wa-")).toBe(true);
    }
  });

  it("phone_number_id مجهول → accepted بصفر معالجة (200 لـ Meta، لوغ عندنا)", async () => {
    const f = makeService({ tenantRow: undefined });
    const { raw, sig, parsed } = signed(SAMPLE);
    const r = await f.service.ingest(raw, sig, parsed);
    expect(r).toEqual({ outcome: "accepted", enqueued: 0 });
    expect(f.queueAdd).not.toHaveBeenCalled();
  });

  it("إعادة إرسال من Meta: الإدراج يتصادم — يُعاد للطابور فقط العالق received (crash سابق)", async () => {
    const f = makeService({
      tenantRow: { id: TENANT, status: "active" },
      insertReturns: [], // كل المفاتيح موجودة سلفاً
      stuckReturns: [{ id: "stuck-row" }], // واحد منها received — crash قبل المعالجة
    });
    const { raw, sig, parsed } = signed(SAMPLE);
    const r = await f.service.ingest(raw, sig, parsed);
    expect(r).toEqual({ outcome: "accepted", enqueued: 1 });
    expect(f.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("مستأجر موقوف → لا معالجة (drop صامت)", async () => {
    const f = makeService({ tenantRow: { id: TENANT, status: "suspended" } });
    const { raw, sig, parsed } = signed(SAMPLE);
    const r = await f.service.ingest(raw, sig, parsed);
    expect(r).toEqual({ outcome: "accepted", enqueued: 0 });
    expect(f.insertedValues()).toHaveLength(0);
  });

  it("قناة غير مهيأة (بلا META_APP_SECRET) → not_configured بلا أي معالجة", async () => {
    const f = makeService({ env: { META_APP_SECRET: undefined } });
    const { raw, sig, parsed } = signed(SAMPLE);
    const r = await f.service.ingest(raw, sig, parsed);
    expect(r).toEqual({ outcome: "not_configured", enqueued: 0 });
  });
});
