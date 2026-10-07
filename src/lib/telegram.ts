import "server-only";
import { env } from "./env";

const API = "https://api.telegram.org";

export interface InlineButton {
  text: string;
  url: string;
}

export interface SendResult {
  chatId: number;
  ok: boolean;
  error?: string;
}

/** HTML-escape. We use parse_mode HTML (not Markdown) because customer and
 *  service names routinely contain characters Markdown treats as syntax. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function call<T>(method: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API}/bot${env.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const parsed = (await resp.json()) as {
    ok: boolean;
    description?: string;
    result?: T;
  };
  if (!parsed.ok) {
    throw new Error(`telegram ${method} failed: ${parsed.description}`);
  }
  return parsed.result as T;
}

export async function sendMessage(
  chatId: number,
  html: string,
  buttons: InlineButton[] = [],
): Promise<void> {
  await call("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(buttons.length
      ? { reply_markup: { inline_keyboard: [buttons.map((b) => b)] } }
      : {}),
  });
}

/** Fan out to every allowlisted chat. One chat blocking the bot or being
 *  deleted must not stop the others, so failures are collected, not thrown. */
export async function broadcast(
  chatIds: number[],
  html: string,
  buttons: InlineButton[] = [],
): Promise<SendResult[]> {
  return Promise.all(
    chatIds.map(async (chatId): Promise<SendResult> => {
      try {
        await sendMessage(chatId, html, buttons);
        return { chatId, ok: true };
      } catch (e) {
        return { chatId, ok: false, error: (e as Error).message };
      }
    }),
  );
}
