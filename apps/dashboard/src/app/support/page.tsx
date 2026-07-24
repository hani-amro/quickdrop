import type { Metadata } from "next";
import { SupportInbox } from "@/components/SupportInbox";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.supportTitle")} — QuickDrop` };
}

// §9 — شاشة خيوط الدعم (customer↔support): قائمة الخيوط يمين، ومحادثة الخيط المحدَّد
// يسار مع الرد والإغلاق. RTL، polling كل 5 ثوانٍ للقائمة والخيط المفتوح.
export default async function SupportPage() {
  const t = await getServerT();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-slate-900">{t("page.supportHeading")}</h1>
      <SupportInbox />
    </div>
  );
}
