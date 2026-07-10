// D6: التخزين UTC دائماً؛ كل حساب تقويمي (تسوية "اليوم") يمر من هنا بمنطقة المستأجر.
export function tenantDay(timezone: string, ts: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ts);
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`tenantDay: missing ${type} part`);
    return part.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}
