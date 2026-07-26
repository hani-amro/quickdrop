import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { adminUsers, auditLog } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §10.2 — دخول المشرف الحقيقي و"الدخول كمكتب". admin_users جدول منصة (استثناء RLS
// مسمّى §2.3) — قراءة/كتابة مباشرة بلا withTenant. audit_log جدول أعمال بـ RLS مفعّل
// → أي كتابة له تمرّ من withTenant (سياسة المستأجر).

/** حقول مصادقة المشرف — لا يُعاد password_hash إلا للتحقق الخادمي (§11: لا يغادر العملية). */
export interface AdminUserAuthRow {
  id: string;
  email: string;
  passwordHash: string;
  totpSecret: string | null;
  totpSecretEnc: Buffer | null; // E1 — قراءة مزدوجة (المشفّر مقدَّم؛ ترحيل 0013)
  isActive: boolean;
}

/** §10.2 — بحث المشرف بالبريد (جدول منصة، بلا مستأجر). غير موجود = undefined (المستدعي يسوّي التوقيت). */
export async function findAdminUserByEmail(db: Db, email: string): Promise<AdminUserAuthRow | undefined> {
  const rows = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      passwordHash: adminUsers.passwordHash,
      totpSecret: adminUsers.totpSecret,
      totpSecretEnc: adminUsers.totpSecretEnc,
      isActive: adminUsers.isActive,
    })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);
  return rows[0];
}

/** E1 — إعادة جلب مادّة TOTP + علم الفعالية بالمعرّف (عند التحقق من دخول 2FA). */
export async function getAdminTotpForVerify(
  db: Db,
  adminId: string,
): Promise<{ totpSecret: string | null; totpSecretEnc: Buffer | null; isActive: boolean } | undefined> {
  const rows = await db
    .select({
      totpSecret: adminUsers.totpSecret,
      totpSecretEnc: adminUsers.totpSecretEnc,
      isActive: adminUsers.isActive,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminId))
    .limit(1);
  return rows[0];
}

/**
 * E1 — حفظ سرّ TOTP المؤكَّد مشفّراً + تصفير النصّي الانتقالي. (admin_users بلا عمود
 * updated_at — لا نضبطه.) جدول منصة معفى من RLS → المقبض الخام بلا withTenant.
 */
export async function setAdminTotpSecret(db: Db, adminId: string, enc: Buffer): Promise<void> {
  await db.update(adminUsers).set({ totpSecretEnc: enc, totpSecret: null }).where(eq(adminUsers.id, adminId));
}

/** E1 — تصفير سرّ TOTP للمشرف (استرداد قفل عبر create-admin --reset-totp): يفرض إعادة التفعيل. */
export async function clearAdminTotpSecret(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .update(adminUsers)
    .set({ totpSecretEnc: null, totpSecret: null })
    .where(eq(adminUsers.email, email))
    .returning({ id: adminUsers.id });
  return rows.length > 0;
}

/**
 * §10.2 — قيد تدقيق ببدء "الدخول كمكتب" (impersonate_start). actorAdminId بمفتاح أجنبي
 * إلى admin_users (يجب أن يكون معرّف مشرف حقيقياً)، وaudit_log بـ RLS → withTenant.
 */
export async function recordImpersonationStart(db: Db, tenantId: string, adminId: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx.insert(auditLog).values({
      tenantId,
      actorAdminId: adminId,
      action: "impersonate_start",
      entity: "tenant",
      entityId: tenantId,
    });
  });
}
