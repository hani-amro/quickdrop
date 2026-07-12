import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getEnv } from "@/env";

// §11 — الـ proxy الخادمي الوحيد للبيانات: يمرر GET/POST إلى ${API_URL}/api/...
// ويحقن Authorization: Bearer ${STAFF_API_TOKEN} + tenantSlug من env —
// التوكن لا يصل المتصفح أبداً، والمتصفح لا يختار المستأجر.

export const dynamic = "force-dynamic";

// مقاطع مسار آمنة فقط (uuid/أسماء موارد) — لا نقاط ولا "/" (منع traversal §11)
const pathSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(4);

interface Ctx {
  params: Promise<{ path: string[] }>;
}

async function forward(req: NextRequest, ctx: Ctx, method: "GET" | "POST"): Promise<NextResponse> {
  const env = getEnv();
  const parsedPath = pathSchema.safeParse((await ctx.params).path);
  if (!parsedPath.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 }); // §11: رسالة عامة
  }
  const path = parsedPath.data.join("/");

  const target = new URL(`${env.API_URL.replace(/\/+$/, "")}/api/${path}`);
  // انسخ الـ query كما هي ثم افرض tenantSlug من env (GET /api/orders يقرؤه من الـ query)
  req.nextUrl.searchParams.forEach((value, key) => {
    if (key !== "tenantSlug") target.searchParams.append(key, value);
  });
  target.searchParams.set("tenantSlug", env.TENANT_SLUG);

  // POST: الجسم JSON object — يُحقن به tenantSlug (عقد POST /api/orders*)
  let body: string | undefined;
  if (method === "POST") {
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
    body = JSON.stringify({ ...(json as Record<string, unknown>), tenantSlug: env.TENANT_SLUG });
  }

  try {
    // §10.2 — إن كان للمتصفح جلسة (كوكي qd_session) مرّرها فيتحقق منها حارس الـ API؛
    // وإلا يبقى Bearer STAFF_API_TOKEN كبديل خادمي (الحارس يقبل أيّهما). الاثنان معاً
    // آمنان: جلسة صالحة تُقبل، وغيابها يسقط لمسار الآلة.
    const browserCookie = req.headers.get("cookie");
    const upstream = await fetch(target, {
      method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.STAFF_API_TOKEN}`,
        ...(browserCookie !== null ? { cookie: browserCookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    // مرّر الحالة والجسم كما هما — رسائل الـ API عامة أصلاً (§11)
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    // §16.12 — لا ابتلاع صامت: لوغ منظّم (بلا أسرار ولا PII) + 502 عام للواجهة
    console.error(JSON.stringify({ action: "dashboard_proxy", outcome: "upstream_unreachable", path }));
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return forward(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return forward(req, ctx, "POST");
}
