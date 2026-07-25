import { newId } from "@quickdrop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrCreateConversation, recordInboundMessage } from "./conversations-service.js";
import { whatsappTemplates } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import {
  claimWaDelivery,
  finalizeWaDeliverySent,
  getApprovedTemplate,
  getLastWhatsAppInboundAt,
  releaseWaDelivery,
} from "./whatsapp-outbound.js";
import { closeHarness, connectHarness, hasDb, seedWorld, type TestHarness } from "./test-helpers.js";

// Task A (D1) — لبنات db: اشتقاق النافذة **خاص بواتساب** (لا يتلوّث بتيليغرام)، عزل سجلّ
// القوالب بين المستأجرين (سلوكي)، وادّعاء exactly-once على صفّ الـoutbox. (العزل الخام لكل
// جداول tenant_id مغطّى تلقائياً بمجس isolation-2tenant المولَّد.)
describe.skipIf(!hasDb)("Task A — whatsapp-outbound (window + template isolation + exactly-once)", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = connectHarness();
  });
  afterAll(async () => {
    await closeHarness(h);
  });

  it("getLastWhatsAppInboundAt خاص بواتساب: يتجاهل رسائل تيليغرام", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    const conversationId = await withTenant(h.app.db, tenantId, async (tx) => {
      const { id } = await getOrCreateConversation(tx, tenantId, customerId);
      // وارد تيليغرام فقط → لا يفتح نافذة واتساب
      await recordInboundMessage(tx, { tenantId, conversationId: id, channel: "telegram", type: "text", content: "tg", externalId: `tg-${id}` });
      return id;
    });
    expect(await withTenant(h.app.db, tenantId, (tx) => getLastWhatsAppInboundAt(tx, tenantId, conversationId))).toBeNull();

    await withTenant(h.app.db, tenantId, (tx) =>
      recordInboundMessage(tx, { tenantId, conversationId, channel: "whatsapp", type: "text", content: "wa", externalId: `wa-${conversationId}` }),
    );
    expect(await withTenant(h.app.db, tenantId, (tx) => getLastWhatsAppInboundAt(tx, tenantId, conversationId))).toBeInstanceOf(Date);
  });

  it("getApprovedTemplate: عزل مستأجرين + يرجع approved فقط", async () => {
    const A = await seedWorld(h.app.db);
    const B = await seedWorld(h.app.db);
    await withTenant(h.app.db, B.tenantId, async (tx) => {
      await tx.insert(whatsappTemplates).values({ tenantId: B.tenantId, internalKey: "order_dispatched", metaTemplateName: "order_dispatched_ms", language: "ms", status: "approved", variableMap: ["code", "driver"] });
      await tx.insert(whatsappTemplates).values({ tenantId: B.tenantId, internalKey: "order_delivered", metaTemplateName: "delivered_ms", language: "ms", status: "pending", variableMap: [] });
    });
    // B يرى قالبه المعتمد
    expect(await withTenant(h.app.db, B.tenantId, (tx) => getApprovedTemplate(tx, B.tenantId, "order_dispatched"))).toEqual({
      metaTemplateName: "order_dispatched_ms",
      language: "ms",
      variableMap: ["code", "driver"],
    });
    // pending لا يُرجَع
    expect(await withTenant(h.app.db, B.tenantId, (tx) => getApprovedTemplate(tx, B.tenantId, "order_delivered"))).toBeNull();
    // A لا يرى قالب B (عزل RLS) — لبّ العزل السلوكي المطلوب
    expect(await withTenant(h.app.db, A.tenantId, (tx) => getApprovedTemplate(tx, A.tenantId, "order_dispatched"))).toBeNull();
  });

  it("claimWaDelivery exactly-once: أول ادّعاء يربح، الثاني يخسر ويرى الموجود؛ finalize→sent؛ release يسمح بإعادة", async () => {
    const { tenantId } = await seedWorld(h.app.db);
    const outboxId = newId();
    const first = await withTenant(h.app.db, tenantId, (tx) => claimWaDelivery(tx, tenantId, outboxId, { mode: "template", status: "claimed", internalKey: "order_dispatched" }));
    expect(first.won).toBe(true);
    const second = await withTenant(h.app.db, tenantId, (tx) => claimWaDelivery(tx, tenantId, outboxId, { mode: "template", status: "claimed", internalKey: "order_dispatched" }));
    expect(second.won).toBe(false);
    expect(second.existing?.status).toBe("claimed");

    await withTenant(h.app.db, tenantId, (tx) => finalizeWaDeliverySent(tx, tenantId, outboxId, "wamid-123"));
    const afterSent = await withTenant(h.app.db, tenantId, (tx) => claimWaDelivery(tx, tenantId, outboxId, { mode: "template", status: "claimed" }));
    expect(afterSent.won).toBe(false);
    expect(afterSent.existing?.status).toBe("sent");
    expect(afterSent.existing?.metaMessageId).toBe("wamid-123");

    // فشل مؤكَّد → تحرير → يمكن إعادة الادّعاء (at-least-once لفشل مؤكَّد)
    await withTenant(h.app.db, tenantId, (tx) => releaseWaDelivery(tx, tenantId, outboxId));
    const reclaim = await withTenant(h.app.db, tenantId, (tx) => claimWaDelivery(tx, tenantId, outboxId, { mode: "template", status: "claimed" }));
    expect(reclaim.won).toBe(true);
  });
});
