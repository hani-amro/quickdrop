import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

// §2.2 — كل وحدة عمل ضمن مستأجر تمر من هنا. لا يوجد مسار آخر للقاعدة.
// set_config(..., is_local=true) يموت مع نهاية الترانزاكشن — آمن مع pgBouncer transaction pooling.
// السياسات تستخدم current_setting الصارمة: أي استعلام خارج withTenant يفشل بصوت عالٍ (§2.3).

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new TypeError("withTenant: tenantId must be a UUID");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
