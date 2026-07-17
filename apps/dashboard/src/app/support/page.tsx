import type { Metadata } from "next";
import { SupportInbox } from "@/components/SupportInbox";

export const metadata: Metadata = { title: "الدعم — QuickDrop" };

// §9 — شاشة خيوط الدعم (customer↔support): قائمة الخيوط يمين، ومحادثة الخيط المحدَّد
// يسار مع الرد والإغلاق. RTL، polling كل 5 ثوانٍ للقائمة والخيط المفتوح.
export default function SupportPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-slate-900">الدعم</h1>
      <SupportInbox />
    </div>
  );
}
