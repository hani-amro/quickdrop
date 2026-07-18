import { encryptSecret } from "@quickdrop/shared";
import { createDb } from "../src/client.js";
import { adminUsers, staff, tenants } from "../src/schema/index.js";
import { withTenant } from "../src/with-tenant.js";
import { eq, isNotNull, isNull, and } from "drizzle-orm";

// ترحيل 0013 — backfill لمرة واحدة: يشفّر الأسرار النصية القائمة إلى أعمدة bytea
// (AES-256-GCM بـ MASTER_KEY) ويصفّر الأعمدة النصية. idempotent: يلتقط فقط الصفوف
// التي ما زال نصّها الصريح موجوداً وعمودها المشفّر فارغاً.
// التشغيل: MASTER_KEY=... DATABASE_URL=... tsx scripts/encrypt-secrets-at-rest.ts

async function main(): Promise<void> {
  const masterKeyHex = process.env["MASTER_KEY"];
  const dbUrl = process.env["DATABASE_URL"];
  if (!masterKeyHex || !/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error("MASTER_KEY (64 hex chars) is required");
  }
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  const masterKey = Buffer.from(masterKeyHex, "hex");
  const handle = createDb(dbUrl);
  let tenantSecrets = 0;
  let adminSecrets = 0;
  let staffSecrets = 0;

  try {
    // tenants (بلا RLS): bot_webhook_secret → bot_webhook_secret_enc
    const tenantRows = await handle.db
      .select({ id: tenants.id, secret: tenants.botWebhookSecret })
      .from(tenants)
      .where(and(isNotNull(tenants.botWebhookSecret), isNull(tenants.botWebhookSecretEnc)));
    for (const row of tenantRows) {
      await handle.db
        .update(tenants)
        .set({ botWebhookSecretEnc: encryptSecret(row.secret!, masterKey), botWebhookSecret: null })
        .where(eq(tenants.id, row.id));
      tenantSecrets += 1;
    }

    // admin_users (بلا RLS): totp_secret → totp_secret_enc
    const adminRows = await handle.db
      .select({ id: adminUsers.id, secret: adminUsers.totpSecret })
      .from(adminUsers)
      .where(and(isNotNull(adminUsers.totpSecret), isNull(adminUsers.totpSecretEnc)));
    for (const row of adminRows) {
      await handle.db
        .update(adminUsers)
        .set({ totpSecretEnc: encryptSecret(row.secret!, masterKey), totpSecret: null })
        .where(eq(adminUsers.id, row.id));
      adminSecrets += 1;
    }

    // staff (تحت FORCE RLS): لكل مستأجر داخل withTenant
    const allTenants = await handle.db.select({ id: tenants.id }).from(tenants);
    for (const t of allTenants) {
      staffSecrets += await withTenant(handle.db, t.id, async (tx) => {
        const rows = await tx
          .select({ id: staff.id, secret: staff.totpSecret })
          .from(staff)
          .where(and(eq(staff.tenantId, t.id), isNotNull(staff.totpSecret), isNull(staff.totpSecretEnc)));
        for (const row of rows) {
          await tx
            .update(staff)
            .set({ totpSecretEnc: encryptSecret(row.secret!, masterKey), totpSecret: null, updatedAt: new Date() })
            .where(and(eq(staff.tenantId, t.id), eq(staff.id, row.id)));
        }
        return rows.length;
      });
    }

    console.log(
      JSON.stringify({
        action: "encrypt_secrets_at_rest",
        tenants_webhook_secrets: tenantSecrets,
        admin_totp_secrets: adminSecrets,
        staff_totp_secrets: staffSecrets,
      }),
    );

    // تحقق ختامي: لا نص صريح متبقٍ بأي من الأعمدة الثلاثة
    const leftovers = await handle.pool.query(
      `SELECT (SELECT count(*) FROM tenants WHERE bot_webhook_secret IS NOT NULL)::int AS t,
              (SELECT count(*) FROM admin_users WHERE totp_secret IS NOT NULL)::int AS a`,
    );
    const { t, a } = leftovers.rows[0] as { t: number; a: number };
    if (t > 0 || a > 0) {
      throw new Error(`plaintext secrets remain after backfill: tenants=${t} admin_users=${a}`);
    }
    console.log("encrypt-secrets-at-rest: OK — no plaintext secrets remain (staff verified per-tenant above)");
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
