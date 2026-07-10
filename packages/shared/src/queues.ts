// أسماء الطوابير — ثابت مشترك: المنتج (api) والمستهلك (worker) يقرآن من هنا.
export const TG_UPDATES_QUEUE = "tg-updates";

export interface TgUpdateJob {
  tenantId: string;
  updateId: number;
}
