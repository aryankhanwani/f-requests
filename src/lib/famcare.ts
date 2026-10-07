import "server-only";
import { env, IST } from "./env";

/** The subset of GET /admin/requests items this bot reads.
 *
 *  Field notes that matter for correctness:
 *  - `amount_inr` is PAISE despite the name. The admin panel divides by 100
 *    (see famcare_admin requests/page.tsx, `baseAmtPaise`). Never show it raw.
 *  - `scheduled_at` is null only for bookings with no slot; the backend's own
 *    "today" filter is COALESCE(scheduled_at, created_at) in IST, which is why
 *    we mirror that exact expression when we re-check locally.
 *  - `parent_request_id` non-null means this row is an extension of another
 *    booking, not a new booking. */
export interface AdminRequest {
  id: string;
  status: string;
  created_at: string | null;
  scheduled_at: string | null;
  end_time: string | null;
  amount_inr: number | null;
  is_instant: boolean;
  parent_request_id: string | null;
  hub_name: string | null;
  nth_booking: number | null;
  user_booking_count: number | null;
  service_zone: "inner" | "outer" | "outside" | null;
  service_zone_distance_km: number | null;
  assigned_rider_id: string | null;
  details: Record<string, unknown> | null;
  rider: { id: string; name: string | null } | null;
  customer: { id: string; name: string | null } | null;
  sub_service: {
    id: string;
    name: string | null;
    service_name: string | null;
    tier_hours: number | null;
    tier_label: string | null;
  } | null;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Cached admin token. Serverless instances are short-lived but warm ones get
 *  reused across several cron ticks, so this avoids a login per pass. */
let cachedToken: { token: string; obtainedAt: number } | null = null;
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;

async function login(): Promise<string> {
  const resp = await fetch(`${env.apiBaseUrl}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.adminUsername,
      password: env.adminPassword,
    }),
    cache: "no-store",
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new ApiError(`admin login -> ${resp.status}: ${text}`, resp.status);
  }
  const parsed = JSON.parse(text) as { token?: string };
  if (!parsed.token) throw new Error("admin login returned no token");
  cachedToken = { token: parsed.token, obtainedAt: Date.now() };
  return parsed.token;
}

async function token(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() - cachedToken.obtainedAt < TOKEN_MAX_AGE_MS
  ) {
    return cachedToken.token;
  }
  return login();
}

async function adminGet<T>(
  path: string,
  params: Record<string, string | number | boolean>,
): Promise<T> {
  const call = async (bearer: string) => {
    const url = new URL(env.apiBaseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    return fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
    });
  };

  let resp = await call(await token());
  // A stale cached token is the one failure worth retrying automatically.
  if (resp.status === 401 || resp.status === 403) {
    resp = await call(await token(true));
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new ApiError(`GET ${path} -> ${resp.status}: ${text}`, resp.status);
  }
  return JSON.parse(text) as T;
}

/** IST calendar date as YYYY-MM-DD. */
export function istDate(d: Date = new Date()): string {
  // en-CA gives ISO-shaped YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** The backend's own "today" predicate, re-evaluated locally:
 *  (COALESCE(scheduled_at, created_at) AT TIME ZONE 'Asia/Kolkata')::date = today.
 *
 *  The endpoint already applies this, but it ALSO admits rows whose *parent* is
 *  today. Re-checking here keeps "service is today" exact regardless. */
export function serviceDateIst(r: AdminRequest): string | null {
  const ts = r.scheduled_at ?? r.created_at;
  return ts ? istDate(new Date(ts)) : null;
}

const PAGE_LIMIT = 50;

/** Statuses that are never a real confirmed booking:
 *  - pending_payment  : an abandoned checkout cart, not an order
 *  - cancelled / cancellation_requested / pending_approval : dead or not yet live
 *  The backend already hides pending_payment when status='all'. */
const NON_BOOKING_STATUSES = new Set([
  "pending_payment",
  "pending_approval",
  "cancelled",
  "cancellation_requested",
]);

/** Statuses a freshly confirmed booking can legitimately be in by the time a
 *  poll sees it.
 *
 *  Why this is wider than {new, scheduled}: payment capture moves a booking to
 *  'new' (instant) or 'scheduled', then `_schedule_assignment` immediately runs
 *  SAA in the background, which can flip it to 'assigned' within seconds
 *  (payments/service.py:1172). Polling only for new+scheduled therefore drops
 *  bookings that get assigned between two passes — the exact bookings the alert
 *  exists for. 'assigned' is included so nothing is ever missed. */
export const ANNOUNCEABLE_STATUSES = new Set(["new", "scheduled", "assigned"]);

/** The two statuses the /today roster reports on, per the brief. */
export const ROSTER_STATUSES = new Set(["new", "scheduled"]);

/** Today's full board, across every hub, excluding dead rows and extensions.
 *
 *  Fetched with status='all' rather than per-status so a booking cannot slip
 *  through by changing status between passes. The admin token is superadmin, so
 *  `resolve_hub_id` returns the hub_id we pass — omitting it means all hubs
 *  (core/admin_security.py:138). `show_dev=false` keeps the backend's own
 *  developer/test-order exclusion on, the same one the admin panel's list uses. */
export async function fetchTodayBoard(): Promise<AdminRequest[]> {
  const out: AdminRequest[] = [];
  for (let page = 1; ; page++) {
    const res = await adminGet<{ items: AdminRequest[]; total: number }>(
      "/admin/requests",
      {
        paginate: true,
        page,
        limit: PAGE_LIMIT,
        status: "all",
        date_filter: "today",
        show_dev: false,
      },
    );
    out.push(...res.items);
    if (out.length >= res.total || res.items.length === 0) break;
    // Hard stop: a hub-day is ~50 bookings, so this only trips on a bug.
    if (page > 20) break;
  }

  const today = istDate();
  const byId = new Map<string, AdminRequest>();
  for (const r of out) {
    // Extensions are separate `requests` rows sharing the parent's slot; they
    // are not new bookings, so they must not be announced as one.
    if (r.parent_request_id) continue;
    if (NON_BOOKING_STATUSES.has(r.status)) continue;
    // date_filter=today also admits rows whose PARENT is today; re-checking the
    // backend's own predicate locally keeps "service is today" exact.
    if (serviceDateIst(r) !== today) continue;
    byId.set(r.id, r);
  }

  return [...byId.values()].sort((a, b) => {
    const at = a.scheduled_at ?? a.created_at ?? "";
    const bt = b.scheduled_at ?? b.created_at ?? "";
    return at.localeCompare(bt);
  });
}

/** Today's new + scheduled bookings — what /today reports. */
export async function fetchTodayBookings(): Promise<AdminRequest[]> {
  return (await fetchTodayBoard()).filter((r) => ROSTER_STATUSES.has(r.status));
}
