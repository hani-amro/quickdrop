import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminEnv } from "@/env";

// §10.2 + E1 — proxy مصادقة المشرف (منفصل عن مصادقة الطاقم): يمرّر أفعال المصادقة إلى
// ${API_URL}/api/admin/auth/* وينقل Set-Cookie (جلسة qd_admin HttpOnly) من الـ API إلى
// المتصفح. لا يحقن ADMIN_API_TOKEN أبداً — الجلسة هي السلطة. أسماء مسطّحة (segment واحد)
// تُخطَّط لمسارات upstream المائلة (totp/verify …).
export const dynamic = "force-dynamic";

const actionSchema = z.enum(["login", "logout", "session", "totp-verify", "totp-enroll", "totp-enroll-confirm"]);
type Action = z.infer<typeof actionSchema>;

// خريطة الفعل المسطّح → مسار upstream. وأفعال POST التي تحمل جسم JSON.
const UPSTREAM: Record<Action, string> = {
  login: "login",
  logout: "logout",
  session: "session",
  "totp-verify": "totp/verify",
  "totp-enroll": "totp/enroll",
  "totp-enroll-confirm": "totp/enroll/confirm",
};
const JSON_BODY_ACTIONS = new Set<Action>(["login", "totp-verify", "totp-enroll-confirm"]);

interface Ctx {
  params: Promise<{ action: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const parsed = actionSchema.safeParse((await ctx.params).action);
  if (!parsed.success || parsed.data === "session") {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  return forward(req, parsed.data, "POST");
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const parsed = actionSchema.safeParse((await ctx.params).action);
  if (!parsed.success || parsed.data !== "session") {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  return forward(req, "session", "GET");
}

async function forward(req: NextRequest, action: Action, method: "GET" | "POST"): Promise<NextResponse> {
  const env = getAdminEnv();
  const target = `${env.API_URL.replace(/\/+$/, "")}/api/admin/auth/${UPSTREAM[action]}`;

  let body: string | undefined;
  if (method === "POST" && JSON_BODY_ACTIONS.has(action)) {
    const raw = await req.text();
    let json: unknown = {};
    if (raw.trim() !== "") {
      try {
        json = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "invalid request" }, { status: 400 });
      }
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    body = JSON.stringify(json); // مشرف المنصّة غير مقيّد بمستأجر — لا حقن tenantSlug
  }

  const browserCookie = req.headers.get("cookie");
  try {
    const upstream = await fetch(target, {
      method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(browserCookie !== null ? { cookie: browserCookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    const text = await upstream.text();
    const res = new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
    const setCookie = upstream.headers.get("set-cookie");
    if (setCookie !== null) res.headers.set("set-cookie", setCookie); // نقل جلسة qd_admin للمتصفح
    return res;
  } catch {
    console.error(JSON.stringify({ action: "admin_auth_proxy", outcome: "upstream_unreachable", op: action }));
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
