import "server-only";
import { env, IST } from "./env";
import type { AdminRequest } from "./famcare";
import { istDate } from "./famcare";
import { esc, type InlineButton } from "./telegram";

const timeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function time(ts: string | null): string {
  return ts ? timeFmt.format(new Date(ts)) : "—";
}

function dateTime(ts: string | null): string {
  return ts ? dateTimeFmt.format(new Date(ts)) : "—";
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

export function adminUrl(requestId: string): string {
  // The panel's /requests page defaults its date filter to "today" and opens
  // the drawer for ?id=<uuid> once the list loads, so this deep link lands on
  // the booking itself for exactly the bookings this bot reports.
  return `${env.adminPanelUrl}/requests?id=${requestId}`;
}

export function ctaButton(requestId: string): InlineButton[] {
  return [{ text: "🔗 Open in Admin Panel", url: adminUrl(requestId) }];
}

/** Minutes between confirmation and service start. */
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

function humanLead(mins: number): string {
  if (mins < 0) return "now";
  if (mins < 60) return `in ${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

function serviceLine(r: AdminRequest): string {
  const ss = r.sub_service;
  if (!ss) return "Unknown service";
  const parts = [ss.service_name, ss.name].filter(Boolean).join(" › ");
  const tier =
    ss.tier_label ?? (ss.tier_hours != null ? `${ss.tier_hours}h` : null);
  return tier ? `${parts} · ${tier}` : parts;
}

function customerLine(r: AdminRequest): string {
  const name = r.customer?.name?.trim();
  const nth = r.nth_booking;
  const kind =
    nth == null ? null : nth === 1 ? "first booking" : `booking #${nth}`;
  if (name && kind) return `${esc(name)} (${kind})`;
  if (name) return esc(name);
  return kind ?? "—";
}

function zoneLine(r: AdminRequest): string | null {
  if (!r.service_zone) return null;
  const km =
    r.service_zone_distance_km != null
      ? ` · ${r.service_zone_distance_km} km from hub`
      : "";
  const label =
    r.service_zone === "outside"
      ? "⚠️ outside service radius"
      : `${r.service_zone} circle`;
  return `${label}${km}`;
}

/** The message for one booking.
 *  Deliberately carries no customer phone number. */
export function bookingMessage(
  r: AdminRequest,
  opts: { heading?: string } = {},
): string {
  const shortId = r.id.slice(0, 8);
  const isToday = istDate(new Date(r.scheduled_at ?? r.created_at ?? "")) ===
    istDate();

  const instant = isEffectivelyInstant(r);
  const heading =
    opts.heading ??
    (instant ? "⚡ <b>New INSTANT booking</b>" : "🆕 <b>New booking</b>");

  const lines: string[] = [
    heading,
    "",
    `<b>${esc(serviceLine(r))}</b>`,
    "",
    `🆔 <code>${esc(r.id)}</code>`,
    `📌 Status: <b>${esc(r.status)}</b>${instant ? " · instant" : ""}`,
    `🕐 Booked at: ${esc(dateTime(r.created_at))}`,
    `📅 Scheduled: <b>${esc(dateTime(r.scheduled_at))}</b>${
      isToday ? " (today)" : ""
    }`,
  ];

  const lead = leadMinutes(r);
  if (lead !== null) {
    lines.push(`⏱ Starts ${esc(humanLead(lead))} from booking`);
  }
  if (r.end_time) lines.push(`⏳ Ends: ${esc(time(r.end_time))}`);

  lines.push(
    `🏢 Hub: ${esc(r.hub_name ?? "—")}`,
    `💰 Amount: <b>${esc(rupees(r.amount_inr))}</b>`,
    `👤 Customer: ${customerLine(r)}`,
    `🧑‍⚕️ Caregiver: ${
      r.rider?.name ? esc(r.rider.name) : "<i>unassigned</i>"
    }`,
  );

  const zone = zoneLine(r);
  if (zone) lines.push(`📍 ${esc(zone)}`);

  lines.push("", `#${esc(shortId)}`);
  return lines.join("\n");
}

/** Compact one-line-per-booking roster, for /today. Telegram caps a message at
 *  4096 chars, so long days are chunked by the caller. */
export function rosterLine(r: AdminRequest): string {
  const ss = r.sub_service;
  const label = [ss?.service_name, ss?.name].filter(Boolean).join(" › ");
  const tier =
    ss?.tier_label ?? (ss?.tier_hours != null ? `${ss.tier_hours}h` : "");
  return [
    `<b>${esc(time(r.scheduled_at ?? r.created_at))}</b> · ${esc(label)}${
      tier ? ` (${esc(tier)})` : ""
    }`,
    `   ${esc(r.status)}${isEffectivelyInstant(r) ? " · instant" : ""} · ${esc(
      r.hub_name ?? "—",
    )} · ${esc(rupees(r.amount_inr))} · ${
      r.rider?.name ? esc(r.rider.name) : "unassigned"
    }`,
    `   <a href="${adminUrl(r.id)}">open ${esc(r.id.slice(0, 8))}</a>`,
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
  const header = `📋 <b>Today's bookings — ${esc(
    new Intl.DateTimeFormat("en-IN", {
      timeZone: IST,
      weekday: "short",
      day: "2-digit",
      month: "short",
    }).format(new Date()),
  )}</b>\n<i>new + scheduled, all hubs</i>`;

  const others = board.filter((r) => !["new", "scheduled"].includes(r.status));
  const otherCounts = others.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const footer = others.length
    ? `\n<i>Also on today's board: ${Object.entries(otherCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v} ${esc(k)}`)
        .join(", ")}</i>`
    : "";

  if (bookings.length === 0) {
    return [
      `${header}\n\nNothing currently awaiting dispatch — no bookings in <code>new</code> or <code>scheduled</code>.${footer}`,
    ];
  }

  const counts = bookings.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const totalPaise = bookings.reduce((s, r) => s + (r.amount_inr ?? 0), 0);
  const summary = `\n\n<b>${bookings.length}</b> bookings · ${Object.entries(
    counts,
  )
    .map(([k, v]) => `${v} ${esc(k)}`)
    .join(" · ")} · ${esc(rupees(totalPaise))}\n`;

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
