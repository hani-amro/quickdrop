// رموز الحقن (DI tokens) بملف مستقل بلا استيرادات — يكسر حلقة الاستيراد:
// الخدمات تستورد الرموز من هنا (أو من app.module الذي يعيد تصديرها)، لكن القيم
// تُهيَّأ فور تحميل هذا الملف قبل أي كنترولر، فلا تكون undefined وقت الحقن.
export const ENV = "ENV";
export const DB = "DB";
export const REDIS = "REDIS";
export const TG_QUEUE = "TG_QUEUE";
export const BROADCAST_Q = "BROADCAST_Q";
