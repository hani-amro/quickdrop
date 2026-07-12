import { parseArgs } from "node:util";
import { createDb, staff, tenants, withTenant } from "@quickdrop/db";
import { parseEnv, STAFF_ROLES, type StaffRole } from "@quickdrop/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "../auth/hashing.js";

// §10.2 — إنشاء موظف (يدوي بالمرحلة الحالية؛ إدارة الطاقم من الكونسول لاحقاً):
//   pnpm create-staff -- --tenant-slug demo --email owner@demo.local \
//     --password '••••' --role owner
// upsert على (tenant_id, email) = إعادة تعيين كلمة السر/الدور، لا موظف مكرر.
// كلمة السر لا تُطبع أبداً (§11).

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
  }),
);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "tenant-slug": { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      role: { type: "string", default: "owner" },
    },
  });

  const tenantSlug = values["tenant-slug"];
  const email = values.email?.trim().toLowerCase();
  const password = values.password;
  const role = values.role as string;
  if (!tenantSlug || !email || !password) {
    console.error("usage: create-staff --tenant-slug <slug> --email <email> --password <pw> [--role owner|dispatcher|accountant|support]");
    process.exitCode = 1;
    return;
  }
  if (!(STAFF_ROLES as readonly string[]).includes(role)) {
    console.error(`role must be one of: ${STAFF_ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exitCode = 1;
    return;
  }

  const handle = createDb(env.DATABASE_URL);
  try {
    const tenantRows = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant) {
      console.error(`tenant '${tenantSlug}' not found`);
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(password);
    await withTenant(handle.db, tenant.id, (tx) =>
      tx
        .insert(staff)
        .values({ tenantId: tenant.id, email, passwordHash, role: role as StaffRole })
        .onConflictDoUpdate({
          target: [staff.tenantId, staff.email],
          set: { passwordHash, role: role as StaffRole, isActive: true, updatedAt: new Date() },
        }),
    );

    console.log(JSON.stringify({ action: "staff_created", tenantSlug, email, role }, null, 2));
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
