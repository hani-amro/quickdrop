import { InboxView } from "@/components/InboxView";

// دمج WaFlow (§24) — صفحة الوارد الموحّد: تدمج وارد WaFlow ودعم QuickDrop بواجهة محادثات
// واحدة على المخزن الموحّد (P2.4c). كل البيانات عبر /api/crm خلف البروكسي (لا DB بالواجهة).
export default function InboxPage() {
  return <InboxView />;
}
