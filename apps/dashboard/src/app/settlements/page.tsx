import type { Metadata } from "next";
import { SettlementsTable } from "@/components/SettlementsTable";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.settlementsTitle")} — QuickDrop` };
}

// §8.2 — شاشة التسوية اليومية: صف لكل سائق (متوقَّع/مستلَم/فرق) وإغلاق اليوم.
export default function SettlementsPage() {
  return <SettlementsTable />;
}
