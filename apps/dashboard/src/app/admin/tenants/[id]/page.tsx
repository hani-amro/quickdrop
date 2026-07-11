import type { Metadata } from "next";
import { AdminTenantDetail } from "@/components/admin/AdminTenantDetail";

export const metadata: Metadata = { title: "تفصيل مستأجر — كونسول المشرف" };

// §10.2 — صفحة تفصيل مستأجر: id من المسار (Promise في App Router 15).
export default async function AdminTenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AdminTenantDetail id={id} />;
}
