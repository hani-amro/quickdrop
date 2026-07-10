import type { Metadata } from "next";
import { DriversTable } from "@/components/DriversTable";

export const metadata: Metadata = { title: "السائقون — QuickDrop" };

// §10.1 — شاشة السائقين: قراءة فقط بـ v1 (الوردية والقبول من بوت السائق §6).
export default function DriversPage() {
  return <DriversTable />;
}
