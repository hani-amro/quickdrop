-- P2.4c step 3 (expand/contract — CONTRACT) — إسقاط جداول الدعم القديمة بعد هجرة
-- بياناتها إلى المخزن الموحّد (conversations/messages) والتحقق من التكافؤ (step 2).
-- الفهارس والسياسات تُسقَط مع الجدول. support_messages أولاً (FK إلى support_threads).
DROP TABLE IF EXISTS "support_messages";--> statement-breakpoint
DROP TABLE IF EXISTS "support_threads";
