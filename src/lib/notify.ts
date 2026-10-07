import "server-only";
import { env } from "./env";
import {
  ANNOUNCEABLE_STATUSES,
  ROSTER_STATUSES,
  fetchTodayBoard,
  type AdminRequest,
} from "./famcare";
import {
  activeAllowlist,
  claimBookings,
  isSeeded,
  markSeeded,
  releaseClaims,
} from "./supabase";
import { adminUrl, bookingMessage, ctaButton, rosterMessages } from "./format";
import { broadcast } from "./telegram";

export interface PassResult {
  scanned: number;
  claimed: number;
  announced: number;
  suppressed: number;
  seeded?: number;
  recipients: number;
  failures: string[];
}

/** Should this freshly claimed booking actually be pinged?
 *
 *  Two gates. Status, so a row that somehow surfaces already in progress or
 *  completed is not announced as new. And age, so if the bot (or its cron) was
 *  down for hours, the bookings it missed are absorbed quietly rather than
 *  arriving as a wall of stale alerts people would have to triage. */
function shouldAnnounce(r: AdminRequest, now: number): boolean {
  if (!ANNOUNCEABLE_STATUSES.has(r.status)) return false;
  if (!r.created_at) return false;
  const ageMinutes = (now - new Date(r.created_at).getTime()) / 60_000;
  return ageMinutes <= env.announceMaxAgeMinutes;
}

/** Render what a real pass WOULD announce, touching nothing: no claim, no send.
 *  Use it to eyeball formatting and the today-filter against live data
 *  (GET /api/poll?secret=...&dry=1). */
export async function dryRun(): Promise<{
  scanned: number;
  recipients: number;
  wouldAnnounce: { id: string; status: string; url: string; text: string }[];
  rosterPreview: string[];
}> {
  // A dry run is for checking the backend read and the rendering, so a
  // missing/unreachable Supabase must not mask the thing being inspected.
  const [board, allowlist] = await Promise.all([
    fetchTodayBoard(),
    activeAllowlist().catch(() => [] as { chat_id: number }[]),
  ]);
  const now = Date.now();
  return {
    scanned: board.length,
    recipients: allowlist.length,
    wouldAnnounce: board
      .filter((r) => shouldAnnounce(r, now))
      .map((r) => ({
        id: r.id,
        status: r.status,
        url: adminUrl(r.id),
        text: bookingMessage(r),
      })),
    rosterPreview: rosterMessages(
      board.filter((r) => ROSTER_STATUSES.has(r.status)),
      board,
    ),
  };
}


/** Send a real sample ping to one chat, bypassing the allowlist and the claim
 *  ledger. Guarded by CRON_SECRET at the route.
 *
 *  Exists because the send path is otherwise only exercised once a booking
 *  happens to arrive AND a chat is allowlisted. This proves the token, the HTML
 *  rendering and the CTA button in one call, before deploying anything. */
export async function sendTestPing(chatId: number): Promise<{
  sentBooking: string | null;
  ok: boolean;
  error?: string;
}> {
  const board = await fetchTodayBoard();
  // Prefer a real booking so formatting is tested against real data.
  const sample = board.at(-1);

  const [result] = sample
    ? await broadcast(
        [chatId],
        bookingMessage(sample, {
          heading: "\u{1F9EA} <b>Test ping</b> \u2014 real booking, formatting check",
        }),
        ctaButton(sample.id),
      )
    : await broadcast(
        [chatId],
        "\u{1F9EA} <b>Test ping</b>\n\nThe bot can reach this chat. Today's board " +
          "is currently empty, so there was no real booking to render.",
      );

  return { sentBooking: sample?.id ?? null, ok: result.ok, error: result.error };
}


/** One pass: read today's board, claim whatever is unseen, ping what qualifies.
 *
 *  The claim happens before the send (see claimBookings), so overlapping
 *  invocations never double-announce. A send that fails for EVERY recipient
 *  releases the claim so the next pass retries; a partial failure keeps the
 *  claim, because re-sending would duplicate for whoever did receive it. */
export async function runPass(): Promise<PassResult> {
  const [board, allowlist, seeded] = await Promise.all([
    fetchTodayBoard(),
    activeAllowlist(),
    isSeeded(),
  ]);

  const chatIds = allowlist.map((a) => a.chat_id);
  const failures: string[] = [];
  const base = { scanned: board.length, recipients: chatIds.length };

  // First ever run: absorb whatever is already on today's board rather than
  // firing a ping for each one.
  if (!seeded) {
    const absorbed = await claimBookings(board, { announced: false });
    await markSeeded(absorbed.length);
    if (chatIds.length) {
      const results = await broadcast(
        chatIds,
        "✅ <b>FamCare booking bot armed.</b>\n\n" +
          `${absorbed.length} booking(s) already on today's board were absorbed silently. ` +
          "From now on you get a ping the moment a booking is confirmed whose service is today.",
      );
      failures.push(
        ...results.filter((r) => !r.ok).map((r) => `${r.chatId}: ${r.error}`),
      );
    }
    return {
      ...base,
      claimed: absorbed.length,
      announced: 0,
      suppressed: absorbed.length,
      seeded: absorbed.length,
      failures,
    };
  }

  const fresh = await claimBookings(board, { announced: true });
  const now = Date.now();
  const toAnnounce = fresh.filter((r) => shouldAnnounce(r, now));
  const suppressed = fresh.length - toAnnounce.length;

  if (toAnnounce.length === 0) {
    return { ...base, claimed: fresh.length, announced: 0, suppressed, failures };
  }

  if (chatIds.length === 0) {
    // Nobody to tell. Keep the claim: an empty allowlist is a config problem,
    // not a reason to replay the backlog once someone is finally added.
    return {
      ...base,
      claimed: fresh.length,
      announced: 0,
      suppressed,
      failures: ["allowlist is empty — nobody to notify"],
    };
  }

  let announced = 0;
  const toRelease: string[] = [];

  for (const booking of toAnnounce) {
    const results = await broadcast(
      chatIds,
      bookingMessage(booking),
      ctaButton(booking.id),
    );
    failures.push(
      ...results
        .filter((r) => !r.ok)
        .map((r) => `${booking.id.slice(0, 8)} -> ${r.chatId}: ${r.error}`),
    );
    if (results.some((r) => r.ok)) announced++;
    else toRelease.push(booking.id);
  }

  await releaseClaims(toRelease);

  return { ...base, claimed: fresh.length, announced, suppressed, failures };
}
