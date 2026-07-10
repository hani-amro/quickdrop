import { outbox } from "./schema/misc.js";
import type { Tx } from "./with-tenant.js";

// D9 — لا يُرسَل أي شيء لتيليغرام (أو أي أثر جانبي شبكي) من داخل ترانزاكشن قاعدة بيانات:
// صف الـ outbox يُكتب **بنفس ترانزاكشن** الحدث (§12) — إن نجح الالتزام نجحا معاً، وإن
// حصل rollback لا تُرسَل رسالة عن حدث لم يقع. الإرسال الفعلي مسؤولية عامل الالتقاط
// (apps/worker/outbox-poller) بعد الالتزام. النتيجة at-least-once — كل مستهلك يجب أن
// يكون idempotent بمفتاح إزالة تكرار = outbox.id (§12).
export async function writeOutbox(
  tx: Tx,
  tenantId: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const rows = await tx
    .insert(outbox)
    .values({ tenantId, topic, payload, status: "pending" })
    .returning({ id: outbox.id });
  const row = rows[0];
  if (!row) {
    // §16.12 — لا ابتلاع: INSERT ... RETURNING بلا صف حالة مستحيلة نظرياً؛ فشل صاخب أفضل من undefined صامت.
    throw new Error("writeOutbox: INSERT returned no row");
  }
  return { id: row.id };
}
