import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getEnv } from "@/env";

// §10.2 — proxy مصادقة الطاقم: يمرّر login/logout/me إلى ${API_URL}/api/auth/*
// وينقل Set-Cookie من الـ API إلى المتصفح (والعكس) — جلسة qd_session HttpOnly.
// tenantSlug يُفرض من env (المتصفح لا يختار المستأجر §11).

export const dynamic = "force-dynamic";

const actionSchema = z.enum(["login", "logout", "me"]);

interface Ctx {
  params: Promise<{ action: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const parsed = actionSchema.safeParse((await ctx.params).action);
  if (!parsed.success || parsed.data === "me") {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  return forward(req, parsed.data, "POST");
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const parsed = actionSchema.safeParse((await ctx.params).action);
  if (!parsed.success || parsed.data !== "me") {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  return forward(req, "me", "GET");
}

async function forward(req: NextRequest, action: string, method: "GET" | "POST"): Promise<NextResponse> {
  const env = getEnv();
  const target = `${env.API_URL.replace(/\/+$/, "")}/api/auth/${action}`;

  let body: string | undefined;
  if (method === "POST" && action === "login") {
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
    // المتصفح يرسل بريداً وكلمة سر فقط؛ tenantSlug يُفرض هنا (§11)
    body = JSON.stringify({ ...(json as Record<string, unknown>), tenantSlug: env.TENANT_SLUG });
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
    // انقل الكوكي (الجلسة أو محوها) من الـ API إلى المتصفح — قلب مصادقة §10.2
    const setCookie = upstream.headers.get("set-cookie");
    if (setCookie !== null) res.headers.set("set-cookie", setCookie);
    return res;
  } catch {
    console.error(JSON.stringify({ action: "auth_proxy", outcome: "upstream_unreachable", op: action }));
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
