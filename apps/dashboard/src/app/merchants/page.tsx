import type { Metadata } from "next";
import { MerchantsManager } from "@/components/MerchantsManager";

export const metadata: Metadata = { title: "المطاعم — QuickDrop" };

// §3 — شاشة إدارة التجار وكتالوجهم: قائمة المطاعم، أصنافها (اسم/سعر/توفّر)،
// وإضافة تاجر بنقطة على الخريطة. RTL، تحديثات تفاؤلية.
export default function MerchantsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-slate-900">المطاعم والتجار</h1>
      <MerchantsManager />
    </div>
  );
}
