import type { Metadata } from "next";
import { MerchantsManager } from "@/components/MerchantsManager";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.merchantsTitle")} — QuickDrop` };
}

// §3 — شاشة إدارة التجار وكتالوجهم: قائمة المطاعم، أصنافها (اسم/سعر/توفّر)،
// وإضافة تاجر بنقطة على الخريطة. RTL، تحديثات تفاؤلية.
export default async function MerchantsPage() {
  const t = await getServerT();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-slate-900">{t("page.merchantsHeading")}</h1>
      <MerchantsManager />
    </div>
  );
}
