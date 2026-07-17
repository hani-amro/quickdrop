import type { MessageDirection, SupportThreadStatus } from "@quickdrop/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { writeOutbox } from "./outbox.js";
import { supportMessages, supportThreads, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §9 (خيوط الدعم) — مراسلة زبون↔مكتب: الزبون يكتب للبوت (رسالة in)، والموظف يرد من
// الداشبورد (رسالة out) فيصل الرد للزبون عبر البوت. كل الوصول عبر withTenant (RLS §2.2)؛
// رد الموظف يكتب صف outbox 'support.reply' **بنفس الترانزاكشن** (D9) ليوقظ المستهلك للإرسال.

/** §9 — صف قائمة الخيوط باللوحة: الخيط + هوية الزبون + آخر رسالة وعدّادها. */
export interface SupportThreadListItem {
  id: string;
  userId: string;
  userName: string | null;
  userPhone: string | null;
  status: SupportThreadStatus;
  assignedStaffId: string | null;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
  messageCount: number;
  createdAt: Date;
}

/** §9 — تفاصيل خيط واحد: الترويسة + كل رسائله (in/out) مرتّبة زمنياً تصاعدياً. */
export interface SupportThreadDetail {
  thread: {
    id: string;
    userId: string;
    userName: string | null;
    userPhone: string | null;
    status: SupportThreadStatus;
    assignedStaffId: string | null;
    createdAt: Date;
  };
  messages: { id: string; direction: MessageDirection; text: string; createdAt: Date }[];
}

export type StaffReplyOutcome =
  | { outcome: "sent"; threadId: string }
  | { outcome: "not_found" } // خيط غير موجود لهذا المستأجر
  | { outcome: "closed" }; // خيط مغلق — لا رد قبل إعادة فتحه (v1: خيط جديد بأول رسالة زبون)

export type CloseThreadOutcome = { outcome: "closed" } | { outcome: "not_found" };

/**
 * §9 — رسالة واردة من الزبون: ابحث عن خيطه المفتوح (status='open') أو أنشئ واحداً،
 * ثم أدرِج رسالة in. يعيد threadId وهل الخيط جديد (لإشعار المكتب لاحقاً إن لزم).
 */
export async function appendInboundMessage(
  db: Db,
  tenantId: string,
  userId: string,
  text: string,
  tgMessageId?: number,
): Promise<{ threadId: string; isNewThread: boolean }> {
  return withTenant(db, tenantId, async (tx) => {
    const open = await tx
      .select({ id: supportThreads.id })
      .from(supportThreads)
      .where(
        and(
          eq(supportThreads.tenantId, tenantId),
          eq(supportThreads.userId, userId),
          eq(supportThreads.status, "open"),
        ),
      )
      .orderBy(asc(supportThreads.createdAt))
      .limit(1);

    let threadId = open[0]?.id;
    let isNewThread = false;
    if (threadId === undefined) {
      // «احصل-أو-أنشئ» آمن ضد السباق: الفهرس الجزئي الفريد (خيط مفتوح واحد/زبون) يجعل
      // إدراجاً متزامناً ثانياً يتعارض؛ onConflictDoNothing يبتلعه بلا خطأ، ثم نعيد
      // القراءة فنرى صف الفائز (ملتزَماً — READ COMMITTED). (الفخ 7: سباق رسالتين).
      const inserted = await tx
        .insert(supportThreads)
        .values({ tenantId, userId, status: "open" })
        .onConflictDoNothing()
        .returning({ id: supportThreads.id });
      const row = inserted[0];
      if (row) {
        threadId = row.id;
        isNewThread = true;
      } else {
        const reselect = await tx
          .select({ id: supportThreads.id })
          .from(supportThreads)
          .where(and(eq(supportThreads.tenantId, tenantId), eq(supportThreads.userId, userId), eq(supportThreads.status, "open")))
          .limit(1);
        threadId = reselect[0]?.id;
        if (threadId === undefined) {
          // §16.12 — تعارض بلا صف عند إعادة القراءة حالة مستحيلة (الفائز التزم) — فشل صاخب
          throw new Error("appendInboundMessage: open thread vanished after ON CONFLICT");
        }
      }
    }

    // §12 — idempotent ضد إعادة تسليم التحديث: الفهرس الجزئي (tenant, thread, tg_message_id)
    // يمنع تكرار الرسالة الواردة؛ onConflictDoNothing يبتلع الإعادة بلا صف مكرر ولا خطأ.
    await tx
      .insert(supportMessages)
      .values({
        tenantId,
        threadId,
        direction: "in",
        text,
        // exactOptionalPropertyTypes: لا نمرّر undefined صريحاً
        ...(tgMessageId !== undefined ? { tgMessageId } : {}),
      })
      .onConflictDoNothing();
    // نلمس updated_at كي يعكس نشاط الخيط (لا يمسّ ترتيب القائمة الذي يعتمد آخر رسالة).
    await tx.update(supportThreads).set({ updatedAt: new Date() }).where(eq(supportThreads.id, threadId));

    return { threadId, isNewThread };
  });
}

/**
 * §9 — قائمة خيوط المستأجر (اختيارياً بحالة) مع هوية الزبون وآخر رسالة وعدّادها.
 * آخر رسالة عبر استعلامات فرعية مترابطة (support_messages ضمن نفس ترانزاكشن المستأجر
 * فيسري RLS)؛ الترتيب بزمن آخر رسالة تنازلياً، وخيط بلا رسائل يسقط على created_at.
 */
export async function listSupportThreads(
  db: Db,
  tenantId: string,
  status?: SupportThreadStatus,
): Promise<SupportThreadListItem[]> {
  return withTenant(db, tenantId, async (tx) => {
    const conditions = [eq(supportThreads.tenantId, tenantId)]; // فوق RLS
    if (status !== undefined) conditions.push(eq(supportThreads.status, status));

    const lastAt = sql<Date | null>`(SELECT sm.created_at FROM support_messages sm WHERE sm.tenant_id = ${supportThreads.tenantId} AND sm.thread_id = ${supportThreads.id} ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1)`;

    const rows = await tx
      .select({
        id: supportThreads.id,
        userId: supportThreads.userId,
        userName: users.firstName,
        userPhone: users.phoneE164,
        status: supportThreads.status,
        assignedStaffId: supportThreads.assignedStaffId,
        createdAt: supportThreads.createdAt,
        lastMessageText: sql<
          string | null
        >`(SELECT sm.text FROM support_messages sm WHERE sm.tenant_id = ${supportThreads.tenantId} AND sm.thread_id = ${supportThreads.id} ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1)`,
        lastMessageAt: lastAt,
        messageCount: sql<number>`(SELECT count(*)::int FROM support_messages sm WHERE sm.tenant_id = ${supportThreads.tenantId} AND sm.thread_id = ${supportThreads.id})`,
      })
      .from(supportThreads)
      .innerJoin(users, and(eq(users.tenantId, supportThreads.tenantId), eq(users.id, supportThreads.userId)))
      .where(and(...conditions))
      .orderBy(sql`COALESCE(${lastAt}, ${supportThreads.createdAt}) DESC`);

    return rows;
  });
}

/** §9 — خيط واحد بترويسته وكل رسائله (createdAt تصاعدياً) — null إن لم يوجد لهذا المستأجر. */
export async function getSupportThread(
  db: Db,
  tenantId: string,
  threadId: string,
): Promise<SupportThreadDetail | null> {
  return withTenant(db, tenantId, async (tx) => {
    const threadRows = await tx
      .select({
        id: supportThreads.id,
        userId: supportThreads.userId,
        userName: users.firstName,
        userPhone: users.phoneE164,
        status: supportThreads.status,
        assignedStaffId: supportThreads.assignedStaffId,
        createdAt: supportThreads.createdAt,
      })
      .from(supportThreads)
      .innerJoin(users, and(eq(users.tenantId, supportThreads.tenantId), eq(users.id, supportThreads.userId)))
      .where(and(eq(supportThreads.tenantId, tenantId), eq(supportThreads.id, threadId)))
      .limit(1);
    const thread = threadRows[0];
    if (!thread) return null;

    const messages = await tx
      .select({
        id: supportMessages.id,
        direction: supportMessages.direction,
        text: supportMessages.text,
        createdAt: supportMessages.createdAt,
      })
      .from(supportMessages)
      .where(and(eq(supportMessages.tenantId, tenantId), eq(supportMessages.threadId, threadId)))
      .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));

    return { thread, messages };
  });
}

/**
 * §9 — رد الموظف على خيط: يقفل صف الخيط FOR UPDATE (§16.11)؛ غير موجود/مغلق → لا رد.
 * يدرِج رسالة out، ويُسند الخيط للموظف إن كان بلا مُسنَد، ويكتب صف outbox 'support.reply'
 * **بنفس الترانزاكشن** (D9) — إن التزم الترانزاكشن أُرسِل الرد للزبون، وإلا لا شيء يُرسَل.
 */
export async function staffReplyToThread(
  db: Db,
  tenantId: string,
  threadId: string,
  staffId: string | null,
  text: string,
): Promise<StaffReplyOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: supportThreads.id,
        status: supportThreads.status,
        assignedStaffId: supportThreads.assignedStaffId,
      })
      .from(supportThreads)
      .where(and(eq(supportThreads.tenantId, tenantId), eq(supportThreads.id, threadId)))
      .for("update");
    const thread = rows[0];
    if (!thread) return { outcome: "not_found" as const };
    if (thread.status === "closed") return { outcome: "closed" as const };

    await tx.insert(supportMessages).values({ tenantId, threadId, direction: "out", text });

    await tx
      .update(supportThreads)
      .set({
        updatedAt: new Date(),
        // أول من يرد يملك الخيط؛ لا نكتب فوق مُسنَد سابق (ولا نمرّر undefined — D exactOptional)
        ...(thread.assignedStaffId === null && staffId !== null ? { assignedStaffId: staffId } : {}),
      })
      .where(eq(supportThreads.id, threadId));

    // D9/§12 — صف outbox بنفس الترانزاكشن: المستهلك يرسل الرد للزبون عبر بوت المستأجر.
    await writeOutbox(tx, tenantId, "support.reply", { threadId, text });

    return { outcome: "sent" as const, threadId };
  });
}

/** §9 — إغلاق خيط: status='closed' وإسناده للموظف إن كان بلا مُسنَد. غير موجود → not_found. */
export async function closeSupportThread(
  db: Db,
  tenantId: string,
  threadId: string,
  staffId: string | null,
): Promise<CloseThreadOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: supportThreads.id, assignedStaffId: supportThreads.assignedStaffId })
      .from(supportThreads)
      .where(and(eq(supportThreads.tenantId, tenantId), eq(supportThreads.id, threadId)))
      .for("update");
    const thread = rows[0];
    if (!thread) return { outcome: "not_found" as const };

    await tx
      .update(supportThreads)
      .set({
        status: "closed",
        updatedAt: new Date(),
        ...(thread.assignedStaffId === null && staffId !== null ? { assignedStaffId: staffId } : {}),
      })
      .where(eq(supportThreads.id, threadId));

    return { outcome: "closed" as const };
  });
}
