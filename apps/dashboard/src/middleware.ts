import { NextResponse, type NextRequest } from "next/server";

// §10.2 — بوابة صفحات الطاقم: بلا كوكي جلسة → تحويل إلى /login. فحص وجود فقط
// (التحقق الفعلي عند الـ API عبر الحارس)؛ كونسول المشرف /admin نطاق منفصل بمصادقته
// الخاصة، وصفحة التتبع العامة /t/... و/login والأصول مستثناة.
const SESSION_COOKIE = "qd_session";

export function middleware(req: NextRequest): NextResponse {
  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// طابِق صفحات الطاقم فقط: استثنِ /login و/admin (نطاق مشرف) و/t (تتبع عام)
// و/api (المسارات لها حراسها) والأصول الثابتة.
export const config = {
  matcher: ["/((?!login|admin|t/|api|_next/static|_next/image|favicon.ico).*)"],
};
