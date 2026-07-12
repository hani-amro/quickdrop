-- PostGIS (D7) — يتطلب superuser، لذلك هنا وليس بالترحيلات.
-- صورة postgis/postgis تنشئه تلقائياً؛ هذا السطر ضمان لأي قاعدة أُنشئت بغير الصورة.
CREATE EXTENSION IF NOT EXISTS postgis;
