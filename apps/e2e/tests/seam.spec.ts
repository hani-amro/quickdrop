import { expect, test } from "@playwright/test";

// MERGE_PLAN §7 (Phase 1 خطوة 10) — عقد المفصل بين الدماغين، يفشل عمداً حتى Phase 3.
// ⛔ قائمة §4.2 الحاجبة (قرار المالك 2026-07-18): لا يُرفع الـ fixme قبل أن تتغير مواقع
// الكود الست hard-coded على 'confirmed' (dispatch.ts ×4، notifications-consumer:239،
// merchant-bot:161) ويثبت الاختباران: pickup لا يُرسل سائقاً، وseam الطعام يُطلق مرة واحدة.
test.describe("العمود الفقري — order.ready_for_dispatch (يتحقق بـ Phase 3)", () => {
  test.fixme(
    "طلب واتساب مدفوع → payment.paid → confirm → ready → order.ready_for_dispatch يُطلق مرة واحدة → جولة إسناد",
    async ({ request }) => {
      // Phase 3: أنشئ طلب food عبر مسار الاستقبال، ادفعه (Billplz test)، علّمه ready،
      // ثم أثبت: صف outbox واحد بالموضوع order.ready_for_dispatch (ختم write-once
      // dispatch_requested_at)، وجولة إسناد واحدة بالضبط تحت 5 أحداث متطابقة متزامنة.
      const response = await request.get("/health");
      expect(response.status()).toBe(200);
      throw new Error("seam not wired yet — Phase 3 (§4.2 blocking checklist)");
    },
  );

  test.fixme("طلب fulfillment=pickup لا يصل الإسناد أبداً (لا سائق يُرسل فيزيائياً)", async () => {
    // Phase 3: طلب pickup مؤكّد ومدفوع → صفر صفوف offers وصفر مهام dispatch-order
    // (adversary #2 — الحارس القديم to==='confirmed' كان يُرسل سائقاً لطلب استلام ذاتي).
    throw new Error("seam not wired yet — Phase 3 (§4.2 blocking checklist)");
  });
});
