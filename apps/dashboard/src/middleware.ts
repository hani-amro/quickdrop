import { NextResponse, type NextRequest } from "next/server";

// §10.2/§11 — بوابة الصفحات: صفحات الطاقم تتطلب qd_session (→ /login)، وكونسول المشرف
// /admin يتطلب qd_admin (→ /admin/login). فحص وجود الكوكي فقط (التحقق الفعلي عند الـ API
// عبر الحرّاس)؛ /login و/admin/login و/t/... (تتبع عام) و/api والأصول مستثناة/تُعالج ذاتياً.
// سابقاً كان /admin بلا بوابة إطلاقاً فتُحمَّل صفحاته لأي زائر (البيانات كانت تُحقن بتوكن آلة).
const SESSION_COOKIE = "qd_session";
const ADMIN_COOKIE = "qd_admin";

export function middleware(req: NextRequest): NextResponse {
  const path = req.nextUrl.pathname;

  // كونسول المشرف: نطاق منفصل بجلسة qd_admin — صفحة الدخول نفسها مستثناة (لا حلقة تحويل)
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (path === "/admin/login") return NextResponse.next();
    if (!req.cookies.has(ADMIN_COOKIE)) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // صفحات الطاقم: جلسة qd_session
  if (!req.cookies.has(SESSION_COOKIE)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// طابِق كل صفحات التطبيق عدا /login و/admin/login (يُعالجان ذاتياً أعلاه أو مستثنيان)
// و/t (تتبع عام) و/api (لها حراسها) والأصول الثابتة. /admin الآن **مشمول** (كان مستثنى).
export const config = {
  matcher: ["/((?!login|t/|api|_next/static|_next/image|favicon.ico).*)"],
};
