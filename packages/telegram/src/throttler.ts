import { GrammyError, type Transformer } from "grammy";

// §4.3 — throttler لكل بوت: كل الإرسال يمر من هنا. الحدود (هامش تحت سقوف تيليغرام):
//   ≤25 msg/s إجمالاً للبوت (السقف ~30)، و≤1 msg/s لنفس المحادثة الخاصة.
//   429: اقرأ retry_after ونَم المدة + jitter ثم أعد المحاولة مرة واحدة (تجاهلها =
//   حظر مؤقت للبوت كله = كل زبائن هذا المكتب).

const SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendLocation",
  "editMessageText",
  "editMessageCaption",
  "editMessageLiveLocation",
  "copyMessage",
  "forwardMessage",
]);

export interface ThrottleOptions {
  globalPerSec: number; // إجمالي البوت
  perChatPerSec: number; // لكل محادثة
}

const DEFAULTS: ThrottleOptions = { globalPerSec: 25, perChatPerSec: 1 };

export interface ThrottleState {
  globalNextAt: number;
  chatNextAt: Map<string, number>;
}

export function newThrottleState(): ThrottleState {
  return { globalNextAt: 0, chatNextAt: new Map() };
}

/**
 * القرار النقي: متى يُسمح بالإرسال التالي، ويحدّث الحالة. يرجع التأخير (ms) من الآن.
 * chatId=null (طرق بلا محادثة) → قيد عالمي فقط.
 */
export function computeSendDelay(
  state: ThrottleState,
  chatId: string | null,
  now: number,
  opts: ThrottleOptions = DEFAULTS,
): number {
  const globalGap = 1000 / opts.globalPerSec;
  const chatGap = 1000 / opts.perChatPerSec;
  const globalReady = Math.max(now, state.globalNextAt);
  const chatReady = chatId !== null ? Math.max(now, state.chatNextAt.get(chatId) ?? 0) : now;
  const sendAt = Math.max(globalReady, chatReady);
  state.globalNextAt = sendAt + globalGap;
  if (chatId !== null) state.chatNextAt.set(chatId, sendAt + chatGap);
  return sendAt - now;
}

function chatIdOf(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null) {
    const id = (payload as Record<string, unknown>)["chat_id"];
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * §4.3 — transformer الـ throttler لبوت واحد. حالة محلية لكل instance (كل مستأجر
 * يحصل على واحدة عبر createTenantBot). now/sleep قابلان للحقن للاختبار.
 */
export function createThrottler(opts: Partial<ThrottleOptions> & {
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
} = {}): Transformer {
  const options: ThrottleOptions = { ...DEFAULTS, ...opts };
  const now = opts.now ?? ((): number => Date.now());
  const doSleep = opts.sleepFn ?? sleep;
  const state = newThrottleState();

  return async (prev, method, payload, signal) => {
    if (!SEND_METHODS.has(method)) return prev(method, payload, signal);

    const delay = computeSendDelay(state, chatIdOf(payload), now(), options);
    if (delay > 0) await doSleep(delay);

    try {
      return await prev(method, payload, signal);
    } catch (error) {
      // §4.3 — 429: احترم retry_after (+ jitter) وأعد المحاولة مرة واحدة
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfterS = error.parameters.retry_after ?? 1;
        const jitter = 250; // ثابت (لا Math.random حتمية أعلى)؛ يكفي لتفادي التزامن الحاد
        await doSleep(retryAfterS * 1000 + jitter);
        return prev(method, payload, signal);
      }
      throw error; // §16.12 — لا ابتلاع: غير 429 يُعاد رميه
    }
  };
}
