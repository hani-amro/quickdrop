import type { LifecycleStage } from "@quickdrop/shared";
import { and, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client.js";
import { customerProfiles, users } from "./schema/index.js";
import { withTenant, type Tx } from "./with-tenant.js";

// دمج WaFlow (MERGE_PLAN §3.4/§4.3) — **مصدر واحد** لفلتر الجمهور: تشترك فيه Journeys
// (مطابقة نقية على ملف مُحمَّل) والحملات (Campaigns على نمط البث — ترشيح SQL للجمهور).
// الشكل: { lifecycleStage?: string[], minRfm?: 0..100, tags?: string[] }.

export const audienceFilterSchema = z
  .object({
    lifecycleStage: z.array(z.string()).optional(),
    minRfm: z.number().int().min(0).max(100).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

// —— مطابقة نقية (Journeys: الملف مُحمَّل سلفاً) ——
export interface AudienceProfile {
  lifecycleStage: LifecycleStage | null;
  rfmScore: number | null;
  tags: string[];
}

export function matchesAudience(profile: AudienceProfile, filter: AudienceFilter | null): boolean {
  if (!filter) return true;
  if (filter.lifecycleStage && filter.lifecycleStage.length > 0) {
    if (profile.lifecycleStage === null || !filter.lifecycleStage.includes(profile.lifecycleStage)) return false;
  }
  if (filter.minRfm !== undefined && (profile.rfmScore ?? 0) < filter.minRfm) return false;
  if (filter.tags && filter.tags.length > 0) {
    if (!filter.tags.every((t) => profile.tags.includes(t))) return false;
  }
  return true;
}

// —— ترشيح SQL (Campaigns: الجمهور على customer_profiles) ——
// أي شرط ملفّي (lifecycleStage/minRfm/tags) يتطلب INNER JOIN مع customer_profiles، فالزبون
// بلا ملف (لم يحسبه الدماغ بعد) **لا يطابق** فلتراً ملفّياً — مطابق لدلالة matchesAudience
// (lifecycleStage=null/rfmScore=null يسقطان أمام الفلتر). فلتر فارغ/غير موجود → لا شروط.
export function audienceProfileConditions(filter: AudienceFilter | null): SQL[] {
  if (!filter) return [];
  const conds: SQL[] = [];
  if (filter.lifecycleStage && filter.lifecycleStage.length > 0) {
    conds.push(inArray(customerProfiles.lifecycleStage, filter.lifecycleStage as LifecycleStage[]));
  }
  if (filter.minRfm !== undefined) {
    conds.push(gte(customerProfiles.rfmScore, filter.minRfm));
  }
  if (filter.tags && filter.tags.length > 0) {
    // احتواء كل الوسوم (@>): ARRAY[...]::text[] — نفس نمط array في journeys-service
    conds.push(sql`${customerProfiles.tags} @> ARRAY[${sql.join(filter.tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
  }
  return conds;
}

/**
 * §4.3 — عضو جمهور البث/الحملة: المعرّف الداخلي + معرّف تيليغرام (chat_id) للإرسال.
 * الجمهور الأساس = زبائن واصلون (role='customer'، telegram NOT NULL، غير محظورين). الفلتر
 * الملفّي (إن وُجد) يضيّق عبر JOIN مع customer_profiles. الترتيب حتمي (الأقدم أولاً).
 */
export interface AudienceMember {
  userId: string;
  telegramUserId: number;
}

export function audienceBaseConditions(tenantId: string): SQL[] {
  return [
    eq(users.tenantId, tenantId), // فوق RLS — يقود فهرس (tenant_id, ...)
    eq(users.role, "customer"),
    isNotNull(users.telegramUserId),
    isNull(users.blockedAt), // §4.3 — المحظور لا يُرسَل له
  ];
}

/** يبني ويشغّل استعلام الجمهور (JOIN مشروط عند وجود شرط ملفّي). داخل ترانزاكشن مستأجر قائمة. */
export async function selectAudience(
  tx: Tx,
  tenantId: string,
  filter: AudienceFilter | null,
): Promise<AudienceMember[]> {
  const profileConds = audienceProfileConditions(filter);
  const where = and(...audienceBaseConditions(tenantId), ...profileConds);
  let q = tx.select({ userId: users.id, telegramUserId: users.telegramUserId }).from(users).$dynamic();
  if (profileConds.length > 0) {
    q = q.innerJoin(customerProfiles, and(eq(customerProfiles.tenantId, users.tenantId), eq(customerProfiles.userId, users.id)));
  }
  const rows = await q.where(where).orderBy(users.createdAt);
  return rows.flatMap((r) => (r.telegramUserId === null ? [] : [{ userId: r.userId, telegramUserId: r.telegramUserId }]));
}

/** §4.3 — عدد المستهدفين لفلتر (معاينة "الوصول" قبل الإرسال). withTenant (RLS §2.3). */
export async function countAudience(db: Db, tenantId: string, filter: AudienceFilter | null): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const profileConds = audienceProfileConditions(filter);
    const where = and(...audienceBaseConditions(tenantId), ...profileConds);
    let q = tx.select({ n: sql<number>`count(*)::int` }).from(users).$dynamic();
    if (profileConds.length > 0) {
      q = q.innerJoin(customerProfiles, and(eq(customerProfiles.tenantId, users.tenantId), eq(customerProfiles.userId, users.id)));
    }
    const rows = await q.where(where);
    return rows[0]?.n ?? 0;
  });
}
