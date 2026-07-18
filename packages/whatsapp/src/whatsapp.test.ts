import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WaApiError, WaClient } from "./client.js";
import { verifyMetaSignature } from "./signature.js";
import { eventKeysForValue, waChangeValueSchema, waWebhookSchema } from "./webhook-schema.js";

const SECRET = "test-app-secret";
const sign = (body: string): string => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyMetaSignature (§11 — على الجسم الخام، ثابت الزمن)", () => {
  it("توقيع صحيح يمر", () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("جسم معدّل بعد التوقيع يُرفض", () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyMetaSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("هيدر مفقود/مشوّه/بلا بادئة sha256= يُرفض بلا رمي", () => {
    expect(verifyMetaSignature("x", undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature("x", "sha1=abcd", SECRET)).toBe(false);
    expect(verifyMetaSignature("x", "sha256=zzzz", SECRET)).toBe(false);
    expect(verifyMetaSignature("x", "sha256=abcd", SECRET)).toBe(false); // طول خاطئ
  });
});

// حمولة بشكل Meta الحقيقي (رسالة نصية + حدث حالة)
const SAMPLE = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "12345", display_phone_number: "60123456789" },
            contacts: [{ wa_id: "60198765432", profile: { name: "Aisha" } }],
            messages: [{ id: "wamid.abc", from: "60198765432", timestamp: "1737200000", type: "text", text: { body: "hi" } }],
            statuses: [{ id: "wamid.out1", status: "delivered", timestamp: "1737200001" }],
          },
        },
      ],
    },
  ],
};

describe("waWebhookSchema (Zod عند الحدود)", () => {
  it("يفكّ الحمولة الحقيقية ويحفظ phone_number_id للتوجيه", () => {
    const parsed = waWebhookSchema.parse(SAMPLE);
    const value = waChangeValueSchema.parse(parsed.entry[0]!.changes[0]!.value);
    expect(value.metadata.phone_number_id).toBe("12345");
    expect(value.messages![0]!.from).toBe("60198765432");
  });

  it("wa id غير رقمي يُرفض (تحقق from)", () => {
    const bad = structuredClone(SAMPLE) as typeof SAMPLE & { entry: { changes: { value: { messages: { from: string }[] } }[] }[] };
    bad.entry[0]!.changes[0]!.value.messages[0]!.from = "not-a-number";
    expect(() => waChangeValueSchema.parse(bad.entry[0]!.changes[0]!.value)).toThrow();
  });

  it("eventKeysForValue: الرسالة بمعرّفها، والحالة بمفتاح مركّب status:{wamid}:{status} (R-12)", () => {
    const value = waChangeValueSchema.parse(SAMPLE.entry[0]!.changes[0]!.value);
    expect(eventKeysForValue(value)).toEqual(["wamid.abc", "status:wamid.out1:delivered"]);
  });
});

describe("WaClient (عميل واحد رقيق — لا retry داخلي، R-14)", () => {
  function makeClient() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.sent1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new WaClient({ accessToken: "TKN", phoneNumberId: "12345", fetchImpl });
    return { client, calls };
  }

  it("sendText: مسار v-pinned + Bearer + جسم messaging_product", async () => {
    const { client, calls } = makeClient();
    const r = await client.sendText("60198765432", "مرحبا");
    expect(r.messageId).toBe("wamid.sent1");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/12345/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer TKN");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      messaging_product: "whatsapp",
      to: "60198765432",
      type: "text",
      text: { body: "مرحبا", preview_url: false },
    });
  });

  it("sendTemplate وsendButtons: بنية Meta الصحيحة", async () => {
    const { client, calls } = makeClient();
    await client.sendTemplate("601", "order_update", "ar", ["1042"]);
    await client.sendButtons("601", "تأكيد؟", [{ id: "ok", title: "نعم" }]);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      type: "template",
      template: { name: "order_update", language: { code: "ar" }, components: [{ type: "body", parameters: [{ type: "text", text: "1042" }] }] },
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      type: "interactive",
      interactive: { type: "button", action: { buttons: [{ type: "reply", reply: { id: "ok", title: "نعم" } }] } },
    });
  });

  it("خطأ Graph = WaApiError بالحالة والجسم — بلا توكن بالرسالة", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"code":190}}', { status: 401 })) as unknown as typeof fetch;
    const client = new WaClient({ accessToken: "SECRET-TOKEN", phoneNumberId: "12345", fetchImpl });
    const err = await client.sendText("601", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaApiError);
    expect((err as WaApiError).status).toBe(401);
    expect((err as WaApiError).message).not.toContain("SECRET-TOKEN");
  });
});
