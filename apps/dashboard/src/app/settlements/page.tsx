import type { Metadata } from "next";
import { SettlementsTable } from "@/components/SettlementsTable";

export const metadata: Metadata = { title: "التسوية — QuickDrop" };

// §8.2 — شاشة التسوية اليومية: صف لكل سائق (متوقَّع/مستلَم/فرق) وإغلاق اليوم.
export default function SettlementsPage() {
  return <SettlementsTable />;
}
