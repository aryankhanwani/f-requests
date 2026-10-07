import "server-only";
import { env, IST } from "./env";
import type { AdminRequest } from "./famcare";
import { istDate } from "./famcare";
import { esc, type InlineButton } from "./telegram";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const dayFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "2-digit",
  month: "short",
});

const dayWithWeekdayFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  weekday: "short",
  day: "2-digit",
  month: "short",
});

/** "6:00 PM" — en-IN renders am/pm lowercase, which looks like a typo next to
 *  bold text, so normalise it. */
function time(ts: string | null): string {
  return ts ? timeFmt.format(new Date(ts)).replace(/\s*([ap])\.?m\.?/i, (_, p) => ` ${p.toUpperCase()}M`) : "—";
}

function day(ts: string | null): string {
  return ts ? dayFmt.format(new Date(ts)) : "—";
}

/** amount_inr is paise. Mirrors the admin panel's own conversion. */
function rupees(paise: number | null): string {
  if (paise == null) return "—";
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", {
    minimumFractionDigits: r % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "2h 14m" / "45m" / "2d 3h" — compact, no leading verb so callers can frame
 *  it as "in …", "… ago" or "… ahead". */
function duration(mins: number): string {
  const m = Math.round(Math.abs(mins));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hRem = h % 24;
  return hRem ? `${d}d ${hRem}h` : `${d}d`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function adminUrl(requestId: string): string {
  // The panel's /requests page defaults its date filter to "today" and opens
  // the drawer for ?id=<uuid> once the list loads, so this deep link lands on
  // the booking itself for exactly the bookings this bot reports.
  return `${env.adminPanelUrl}/requests?id=${requestId}`;
}

export function ctaButton(requestId: string): InlineButton[] {
  return [{ text: "🔗 Open in Admin Panel", url: adminUrl(requestId) }];
}

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

/** Minutes between confirmation and service start — how far ahead it was booked. */
function leadMinutes(r: AdminRequest): number | null {
  if (!r.scheduled_at || !r.created_at) return null;
  return (
    (new Date(r.scheduled_at).getTime() - new Date(r.created_at).getTime()) /
    60_000
  );
}

/** Is this really an instant booking?
 *
 *  The `is_instant` COLUMN defaults to true and is not cleared on slot
 *  bookings — prod rows exist with is_instant=true and a next-day slot — so
 *  trusting it alone mislabels scheduled bookings. The backend's own
 *  `effective_is_instant()` forces false once lead time reaches 2h, so mirror
 *  that: the flag must agree with a short lead time. */
function isEffectivelyInstant(r: AdminRequest): boolean {
  if (!r.is_instant) return false;
  const lead = leadMinutes(r);
  return lead === null || lead < 120;
}

/** "Today" / "Tomorrow" / "Thu, 09 Oct" — a bare date reads as noise when it is
 *  almost always today, but must not silently hide the case where it is not. */
function dayLabel(ts: string | null): string {
  if (!ts) return "—";
  const d = istDate(new Date(ts));
  const today = istDate();
  if (d === today) return "Today";
  const tomorrow = istDate(new Date(Date.now() + 86_400_000));
  if (d === tomorrow) return "Tomorrow";
  return dayWithWeekdayFmt.format(new Date(ts));
}

// ---------------------------------------------------------------------------
// The booking ping
// ---------------------------------------------------------------------------

/** The message for one booking.
 *
 *  Laid out as four blocks so the eye lands on the actionable parts first:
 *
 *    1. what was booked          (service, tier, instant flag)
 *    2. when and where           (slot, countdown, hub, zone)
 *    3. who                      (customer, caregiver, price, status)
 *    4. provenance               (booked-at, lead, ids)
 *
 *  Everything the flat version carried is still here — nothing was dropped,
 *  only regrouped and given weight. Deliberately no customer phone number.
 *
 *  Telegram HTML only: <b>, <i>, <code>, <a>. No tables or <pre>, which wrap
 *  badly on narrow phone screens. */
export function bookingMessage(
  r: AdminRequest,
  opts: { heading?: string } = {},
): string {
  const instant = isEffectivelyInstant(r);
  const ss = r.sub_service;

  // --- 1. what -------------------------------------------------------------
  const kind = opts.heading ?? (instant ? "⚡ <b>Instant booking</b>" : "🆕 <b>New booking</b>");
  const serviceTop = ss?.service_name ? ` · ${esc(ss.service_name)}` : "";
  const tier = ss?.tier_label ?? (ss?.tier_hours != null ? `${ss.tier_hours}h` : null);

  const lines: string[] = [
    `${kind}${serviceTop}`,
    `<b>${esc(ss?.name ?? "Unknown service")}</b>${tier ? ` · ${esc(tier)}` : ""}`,
    "",
  ];

  // --- 2. when & where -----------------------------------------------------
  const start = r.scheduled_at ?? r.created_at;
  const window = r.end_time
    ? `${time(start)} → ${time(r.end_time)}`
    : time(start);
  lines.push(`🗓 <b>${esc(dayLabel(start))}, ${esc(window)}</b>`);

  // Countdown from NOW, which is what someone reading the alert acts on.
  if (start) {
    const mins = (new Date(start).getTime() - Date.now()) / 60_000;
    lines.push(
      mins >= 0
        ? `⏱ starts in ${esc(duration(mins))}`
        : `⏱ <b>started ${esc(duration(mins))} ago</b>`,
    );
  }

  const place: string[] = [];
  if (r.hub_name) place.push(esc(r.hub_name));
  if (r.service_zone) {
    const km =
      r.service_zone_distance_km != null
        ? `, ${r.service_zone_distance_km} km`
        : "";
    place.push(
      r.service_zone === "outside"
        ? `<b>⚠️ outside service radius</b>${esc(km)}`
        : `${esc(r.service_zone)} circle${esc(km)}`,
    );
  }
  if (place.length) lines.push(`📍 ${place.join(" · ")}`);

  // --- 3. who & how much ---------------------------------------------------
  lines.push("");

  const customer = [
    r.customer?.name?.trim() ? esc(r.customer.name.trim()) : null,
    r.nth_booking != null
      ? r.nth_booking === 1
        ? "<b>first booking</b>"
        : `${ordinal(r.nth_booking)} booking`
      : null,
  ].filter(Boolean);
  lines.push(`👤 ${customer.length ? customer.join(" · ") : "—"}`);

  lines.push(
    r.rider?.name
      ? `🧑‍⚕️ ${esc(r.rider.name)}`
      : "🧑‍⚕️ <b>⚠️ unassigned</b>",
  );

  lines.push(`💰 <b>${esc(rupees(r.amount_inr))}</b> · ${esc(r.status)}`);

  // --- 4. provenance -------------------------------------------------------
  const lead = leadMinutes(r);
  const booked = [
    `Booked ${day(r.created_at)}, ${time(r.created_at)}`,
    lead !== null ? `${duration(lead)} ahead` : null,
    `#${r.id.slice(0, 8)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  lines.push("", `<i>${esc(booked)}</i>`, `<code>${esc(r.id)}</code>`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The /today roster
// ---------------------------------------------------------------------------

/** Two lines per booking: the slot and service, then the operational detail.
 *  Compact enough to scan a whole day, detailed enough to act without opening
 *  each one. */
export function rosterLine(r: AdminRequest): string {
  const ss = r.sub_service;
  const tier =
    ss?.tier_label ?? (ss?.tier_hours != null ? `${ss.tier_hours}h` : null);
  const start = r.scheduled_at ?? r.created_at;
  const window = r.end_time
    ? `${time(start)} → ${time(r.end_time)}`
    : time(start);

  // Unassigned is the one thing worth scanning for, so the warning sits on the
  // caregiver token itself rather than at the head of the line.
  const detail = [
    rupees(r.amount_inr),
    r.hub_name ?? null,
    r.status,
    isEffectivelyInstant(r) ? "instant" : null,
    r.rider?.name ? esc(r.rider.name) : "<b>⚠️ unassigned</b>",
  ].filter(Boolean) as string[];

  return [
    `<b>${esc(window)}</b> · ${esc(ss?.name ?? "Unknown service")}${
      tier ? ` · ${esc(tier)}` : ""
    }`,
    `↳ ${detail
      .map((d) => (d.startsWith("<") ? d : esc(d)))
      .join(" · ")} · <a href="${adminUrl(r.id)}">open</a>`,
  ].join("\n");
}

/** The /today roster. `bookings` is the new+scheduled set the brief asks for;
 *  `board` is today's whole board, used only for the footer.
 *
 *  The footer matters: bookings pass through new/scheduled quickly and then
 *  become assigned/in_progress/completed, so by mid-afternoon the requested
 *  roster is legitimately empty. Without the footer that reads as "the bot is
 *  broken" rather than "everything already moved on". */
export function rosterMessages(
  bookings: AdminRequest[],
  board: AdminRequest[] = bookings,
): string[] {
  const header =
    `📋 <b>Today's bookings</b> · ${esc(dayWithWeekdayFmt.format(new Date()))}\n` +
    `<i>awaiting dispatch — new + scheduled, all hubs</i>`;

  const others = board.filter((r) => !["new", "scheduled"].includes(r.status));
  const otherCounts = others.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const footer = others.length
    ? `\n<i>Also on today's board: ${esc(
        Object.entries(otherCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${v} ${k}`)
          .join(", "),
      )}</i>`
    : "";

  if (bookings.length === 0) {
    return [
      `${header}\n\nNothing awaiting dispatch right now.${footer}`,
    ];
  }

  const unassigned = bookings.filter((r) => !r.rider?.name).length;
  const totalPaise = bookings.reduce((s, r) => s + (r.amount_inr ?? 0), 0);
  const summary =
    `\n\n<b>${bookings.length}</b> awaiting · <b>${esc(rupees(totalPaise))}</b>` +
    (unassigned ? ` · <b>⚠️ ${unassigned} unassigned</b>` : "") +
    "\n";

  // Chunk under Telegram's 4096-char limit with headroom for the header.
  const LIMIT = 3600;
  const chunks: string[] = [];
  let current = header + summary;
  for (const r of bookings) {
    const line = "\n" + rosterLine(r) + "\n";
    if (current.length + line.length > LIMIT) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current.trim()) chunks.push(current);
  if (footer) chunks[chunks.length - 1] += footer;
  return chunks;
}
