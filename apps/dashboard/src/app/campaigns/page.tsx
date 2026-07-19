import { CampaignsManager } from "@/components/CampaignsManager";

// دمج WaFlow (§24) — صفحة الحملات: بث موجّه لشريحة (P2.6) عبر /api/broadcasts خلف
// البروكسي (لا DB بالواجهة). محصور owner/dispatcher بالـ API.
export default function CampaignsPage() {
  return <CampaignsManager />;
}
