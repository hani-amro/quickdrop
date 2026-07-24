import type { Metadata } from "next";
import { DriversTable } from "@/components/DriversTable";
import { getServerT } from "@/lib/i18n/server-t";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerT();
  return { title: `${t("page.driversTitle")} — QuickDrop` };
}

// §10.1 — شاشة السائقين: قراءة فقط بـ v1 (الوردية والقبول من بوت السائق §6).
export default function DriversPage() {
  return <DriversTable />;
}
