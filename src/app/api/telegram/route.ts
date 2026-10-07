import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { fetchTodayBoard, ROSTER_STATUSES } from "@/lib/famcare";
import { isAllowed } from "@/lib/supabase";
import { rosterMessages } from "@/lib/format";
import { esc, sendMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Update {
  message?: {
    chat: { id: number; type: string; title?: string };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
  };
}

const HELP = [
  "<b>FamCare booking bot</b>",
  "",
  "You get a ping the moment a booking is confirmed whose service is <b>today</b> (status <code>new</code> or <code>scheduled</code>), with a button straight to it in the admin panel.",
  "",
  "<b>Commands</b>",
  "/today — today's new + scheduled bookings",
  "/id — show this chat's id (needed to be allowlisted)",
  "/help — this message",
].join("\n");

export async function POST(req: Request) {
  // Telegram echoes the secret configured with setWebhook on every delivery.
  // Without this check the endpoint is a public message sender.
  if (
    req.headers.get("x-telegram-bot-api-secret-token") !==
    env.telegramWebhookSecret
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim();
  // Always 200 to Telegram — a non-2xx makes it retry the same update.
  if (!chatId || !text) return NextResponse.json({ ok: true });

  // Strip the @botname suffix Telegram appends in group chats.
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  try {
    // /id is intentionally outside the allowlist gate: it is how a new person
    // discovers the id you need to add them, and it reveals nothing else.
    if (command === "/id") {
      await sendMessage(
        chatId,
        `Chat id: <code>${chatId}</code>\nType: ${esc(msg.chat.type)}\n\n` +
          `Add it to <code>bot_allowlist</code> in Supabase to receive booking pings.`,
      );
      return NextResponse.json({ ok: true });
    }

    if (!(await isAllowed(chatId))) {
      await sendMessage(
        chatId,
        `🚫 This chat is not allowlisted.\n\nChat id: <code>${chatId}</code> — ask an admin to add it to <code>bot_allowlist</code>.`,
      );
      return NextResponse.json({ ok: true });
    }

    if (command === "/today") {
      const board = await fetchTodayBoard();
      const bookings = board.filter((r) => ROSTER_STATUSES.has(r.status));
      for (const chunk of rosterMessages(bookings, board)) {
        await sendMessage(chatId, chunk);
      }
      return NextResponse.json({ ok: true });
    }

    if (command === "/start" || command === "/help") {
      await sendMessage(chatId, HELP);
      return NextResponse.json({ ok: true });
    }

    if (command.startsWith("/")) {
      await sendMessage(chatId, `Unknown command. ${HELP}`);
    }
  } catch (e) {
    // Report the failure into the chat that caused it rather than leaving the
    // user staring at silence, then still 200 so Telegram stops retrying.
    try {
      await sendMessage(chatId, `⚠️ ${esc((e as Error).message)}`);
    } catch {
      /* chat unreachable; nothing more to do */
    }
  }

  return NextResponse.json({ ok: true });
}
