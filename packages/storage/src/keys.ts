// §11 — اشتقاق مفتاح كائن إثبات التسليم (POD) بالـ S3. المسار يبدأ بالمستأجر: عزل
// منطقي بفضاء المفاتيح موازٍ لعزل RLS بالقاعدة (§2.3)، ثم الطلب، ثم اسم ثابت — كائن
// POD واحد لكل طلب: إعادة إرسال السائق للصورة تستبدل الكائن نفسه (لا صف مرفق مكرر).
// دالة صافية بلا شبكة/قاعدة — قابلة للاختبار وحدةً (§15).
export function podKey(tenantId: string, orderId: string, ext: string): string {
  const normalizedExt = ext.replace(/^\.+/, "").toLowerCase();
  return `tenants/${tenantId}/orders/${orderId}/pod.${normalizedExt}`;
}
