import { Api } from "grammy";

// §4.2 — عمليات إدارة البوت (getMe/setWebhook). التوكن يمر كمعامل ولا يُخزَّن هنا؛
// التشفير والتخزين مسؤولية المستدعي. ممنوع ظهور التوكن بأي لوغ أو رسالة خطأ.

export interface BotInfo {
  id: number;
  username: string;
  firstName: string;
}

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

export function assertTokenShape(token: string): void {
  if (!TOKEN_RE.test(token)) {
    // لا نطبع التوكن نفسه أبداً — حتى الخاطئ منه قد يكون توكناً حقيقياً بخطأ نسخ
    throw new Error("bot token does not match the expected Telegram token format");
  }
}

/** يتحقق أن التوكن حي عبر getMe ويرجع هوية البوت. */
export async function getBotInfo(token: string): Promise<BotInfo> {
  assertTokenShape(token);
  const me = await new Api(token).getMe();
  return { id: me.id, username: me.username, firstName: me.first_name };
}

/** يسجّل الـ webhook بسر الهيدر (§4.1) ويسقط التحديثات المتراكمة القديمة. */
export async function registerWebhook(token: string, url: string, secret: string): Promise<void> {
  await new Api(token).setWebhook(url, {
    secret_token: secret,
    drop_pending_updates: true,
    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"], // الفخ 9
  });
}

export async function removeWebhook(token: string): Promise<void> {
  await new Api(token).deleteWebhook({ drop_pending_updates: false });
}
