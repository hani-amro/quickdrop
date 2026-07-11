import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdminEnv } from "@/env";

// §10.2 — proxy كونسول المشرف: منفصل تماماً عن /api/proxy المكتب. يمرر GET/POST إلى
// ${API_URL}/api/admin/... ويحقن Authorization: Bearer ${ADMIN_API_TOKEN} فقط —
// بلا tenantSlug (مسارات platform غير مقيّدة بمستأجر). التوكن لا يصل المتصفح أبداً.

export const dynamic = "force-dynamic";

// مقاطع مسار آمنة فقط (uuid/أسماء موارد/أفعال) — لا نقاط ولا "/" (منع traversal §11)
const pathSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(4);

interface Ctx {
  params: Promise<{ path: string[] }>;
}

async function forward(req: NextRequest, ctx: Ctx, method: "GET" | "POST"): Promise<NextResponse> {
  const env = getAdminEnv();
  const parsedPath = pathSchema.safeParse((await ctx.params).path);
  if (!parsedPath.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 }); // §11: رسالة عامة
  }
  const path = parsedPath.data.join("/");

  const target = new URL(`${env.API_URL.replace(/\/+$/, "")}/api/admin/${path}`);
  // مرّر الـ query كما هي (ترقيم الصفحات لاحقاً) — لا فرض tenantSlug: هذه مسارات platform
  req.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  // POST: الجسم JSON object يُمرَّر كما هو (لا حقن tenantSlug — عكس proxy المكتب)
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
    body = JSON.stringify(json);
  }

  try {
    const upstream = await fetch(target, {
      method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
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
    console.error(JSON.stringify({ action: "admin_proxy", outcome: "upstream_unreachable", path }));
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return forward(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return forward(req, ctx, "POST");
}
