// MERGE_PLAN §3.1/R-14 — عميل Graph **واحد** (كان عند WaFlow أربع نسخ متباعدة).
// عميل رقيق عمداً: لا إعادة محاولات هنا — كل إرسال إنتاجي يمر outbox → BullMQ
// (attempts/backoff هناك، D9)، وإعادة المحاولة بطبقتين تضاعف الرسائل عند Meta.
// التوكن يمرَّر مفكوكاً لكل نداء (فكّه من bytea مسؤولية المستدعي بالمفتاح الرئيسي).

export const DEFAULT_GRAPH_VERSION = "v21.0";

export class WaApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    // لا يُضمَّن التوكن أبداً؛ جسم الخطأ من Meta قد يحوي تفاصيل مفيدة للتشخيص
    super(`WhatsApp Graph API error ${status}`);
    this.name = "WaApiError";
  }
}

export interface WaClientOptions {
  accessToken: string;
  phoneNumberId: string;
  graphVersion?: string;
  /** حقن fetch للاختبارات؛ الافتراضي fetch العالمي (Node ≥ 18). */
  fetchImpl?: typeof fetch;
}

interface SendResult {
  messageId: string | null;
}

export class WaClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WaClientOptions) {
    const version = opts.graphVersion ?? DEFAULT_GRAPH_VERSION;
    this.base = `https://graph.facebook.com/${version}/${opts.phoneNumberId}`;
    this.token = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await this.fetchImpl(`${this.base}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    const text = await res.text();
    if (!res.ok) throw new WaApiError(res.status, text);
    try {
      const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
      return { messageId: parsed.messages?.[0]?.id ?? null };
    } catch {
      return { messageId: null };
    }
  }

  sendText(to: string, body: string, previewUrl = false): Promise<SendResult> {
    return this.post({ to, type: "text", text: { body, preview_url: previewUrl } });
  }

  /** ردّ بسياق رسالة سابقة (context.message_id). */
  sendReply(to: string, body: string, replyToMessageId: string): Promise<SendResult> {
    return this.post({ to, type: "text", text: { body }, context: { message_id: replyToMessageId } });
  }

  /** قالب HSM معتمد — الطريق الوحيد خارج نافذة الـ 24 ساعة. */
  sendTemplate(to: string, name: string, languageCode: string, bodyParams: string[] = []): Promise<SendResult> {
    return this.post({
      to,
      type: "template",
      template: {
        name,
        language: { code: languageCode },
        ...(bodyParams.length > 0
          ? { components: [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }] }
          : {}),
      },
    });
  }

  /** أزرار تفاعلية — حدود Meta: حتى 3 أزرار، عنوان الزر ≤ 20 حرفاً (تُفرض بحدود الـ API عبر Zod). */
  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<SendResult> {
    return this.post({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    });
  }

  sendList(
    to: string,
    body: string,
    buttonLabel: string,
    rows: { id: string; title: string; description?: string }[],
  ): Promise<SendResult> {
    return this.post({
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: { button: buttonLabel, sections: [{ rows }] },
      },
    });
  }

  sendMediaLink(to: string, kind: "image" | "video" | "audio" | "document", link: string, caption?: string): Promise<SendResult> {
    return this.post({ to, type: kind, [kind]: { link, ...(caption !== undefined ? { caption } : {}) } });
  }

  sendLocation(to: string, latitude: number, longitude: number, name?: string): Promise<SendResult> {
    return this.post({ to, type: "location", location: { latitude, longitude, ...(name !== undefined ? { name } : {}) } });
  }

  sendReaction(to: string, messageId: string, emoji: string): Promise<SendResult> {
    return this.post({ to, type: "reaction", reaction: { message_id: messageId, emoji } });
  }

  async markAsRead(messageId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
    if (!res.ok) throw new WaApiError(res.status, await res.text());
  }
}
