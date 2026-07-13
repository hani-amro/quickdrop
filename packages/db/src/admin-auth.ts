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
      isActive: adminUsers.isActive,
    })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);
  return rows[0];
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
