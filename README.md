# FamCare booking bot

Telegram bot that pings the moment a booking is confirmed whose **service is
today**, with a button straight to that booking in the admin panel. Plus a
`/today` command for the current day's board.

Runs entirely on **Vercel + Supabase**. No extra infrastructure.

---

## What it sends

```
⚡ New INSTANT booking

Baby Care › Toddler Care (1–3 Yr) · 2 Hours

🆔 79f4d3d5-ed20-4e77-a433-0388f3bfde0a
📌 Status: new · instant
🕐 Booked at: 07 Oct, 06:59 pm
📅 Scheduled: 07 Oct, 07:30 pm (today)
⏱ Starts in 31 min from booking
⏳ Ends: 09:30 pm
🏢 Hub: whitefield
💰 Amount: ₹299
👤 Customer: Jenika Osbon (booking #37)
🧑‍⚕️ Caregiver: Arpona Kishan
📍 inner circle · 1.13 km from hub

[ 🔗 Open in Admin Panel ]   ->  /requests?id=<uuid>
```

No customer phone number is ever included, by design. Booking id, booking time,
scheduled time, hub, amount, caregiver and repeat-customer position are.

---

## Setup

### 1. Supabase

Run `supabase/schema.sql` in the SQL editor. It creates three tables:

| table | purpose |
|---|---|
| `bot_allowlist` | which Telegram chats may receive pings / run commands |
| `notified_bookings` | claim ledger, so a booking is never announced twice |
| `bot_state` | one row, marks that the initial silent seed has happened |

### 2. Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather), keep the token.
2. Pick any long random string as the webhook secret.
3. Register the webhook once the app is deployed:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://<your-deployment>/api/telegram",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": ["message"]
      }'
```

4. Message the bot `/id`, then insert that chat id into `bot_allowlist`.
   `/id` is deliberately the one command outside the allowlist gate — it is how
   you discover the id you need to add.

For a group: add the bot to the group, send `/id` there, and allowlist the
(negative) group id instead.

### 3. Vercel

Set every var from `.env.example` in project settings. `FAMCARE_ADMIN_*` must be
a **superadmin** account — `GET /admin/requests` derives hub scope from the
token, so a hub admin would only ever see their own hub's bookings.

`vercel.json` already registers the cron. Vercel injects `CRON_SECRET` as
`Authorization: Bearer $CRON_SECRET` on cron calls, so just set the env var.

> Vercel cron needs the **Pro** plan for minute granularity. On Hobby, cron is
> once a day — point an external scheduler (cron-job.org, Supabase `pg_cron` +
> `pg_net`, GitHub Actions) at
> `https://<deployment>/api/poll?secret=$CRON_SECRET` instead.

---

## Latency: why polling, not SSE

The backend has a real push channel — `GET /admin/events`, a Server-Sent Events
stream that broadcasts `new_request` **at payment capture** (scheduled bookings
from `payments/service.py:1168`, instant ones from
`process_assignment_for_request`). That is a true sub-second signal.

A Vercel function cannot hold a long-lived stream open, so this build polls
instead. To beat Vercel's one-minute cron floor, **one cron invocation runs
several passes** spaced `POLL_PASS_INTERVAL_MS` apart
(`POLL_PASSES_PER_INVOCATION` × that interval, default 4 × 15s). Worst-case
latency is therefore ~15s rather than ~60s.

If truly instant ever matters more than staying on Vercel, swap the poll route
for an SSE consumer of `/admin/events` on any always-on Node host; everything
else in this repo (claim ledger, allowlist, formatting) is reusable as-is. Note
that `new_request` **also re-fires** hours later when a pre-booked job comes
due, tagged `is_scheduled_due: true` — those must be dropped.

---

## How correctness is maintained

Accuracy was the explicit requirement, so the bot reads the **same endpoint the
admin panel's own list reads** rather than reimplementing the query:

`GET /admin/requests?paginate=true&status=all&date_filter=today&show_dev=false`

- **"Today" is the backend's definition**, not ours:
  `(COALESCE(scheduled_at, created_at) AT TIME ZONE 'Asia/Kolkata')::date = today`
  (`service_requests/repository.py:2646`). Re-checked locally too, because that
  filter also admits rows whose *parent* is today.
- **`amount_inr` is paise**, despite the name. Verified against prod: `29900` on
  a ₹299 tier. The admin panel divides by 100 the same way.
- **`show_dev=false`** keeps the backend's developer/test-order exclusion on —
  the same one the admin panel uses, covering `is_developer`, deleted users, the
  `9265248561` test number, `dev_only` services and zero-amount orders.
- **Extensions are excluded.** An extension is a separate `requests` row with
  `parent_request_id` set; it is not a new booking.
- **Dead rows excluded**: `pending_payment` (abandoned carts), `pending_approval`,
  `cancelled`, `cancellation_requested`.
- **`is_instant` is not trusted raw.** The column defaults to `true` and is not
  cleared on slot bookings (prod has `is_instant=true` rows with next-day slots).
  The bot mirrors the backend's `effective_is_instant()` and requires lead time
  under 2h before calling anything instant.
- **Hub-agnostic.** No hub is hardcoded, so the third hub ("Mahadevpura hub")
  is picked up automatically.

### Why it scans all statuses, not just `new` + `scheduled`

The brief asked for `new` and `scheduled` bookings. The bot reports exactly
those in `/today` — but it **polls the whole board**, because payment capture
moves a booking to `new`/`scheduled` and then `_schedule_assignment` runs SAA
immediately, which can flip it to `assigned` within seconds. Polling only those
two statuses would silently drop any booking auto-assigned between two passes.

So: scan everything, then announce anything in `{new, scheduled, assigned}`.
Verified on prod — a mid-afternoon board had **zero** `new`/`scheduled` rows out
of 51, all already `assigned`/`in_progress`/`completed`. A status-keyed poll
would have missed most of the day.

### No duplicates, no backlog blasts

- **Claim before send.** `notified_bookings` is written with
  `INSERT .. ON CONFLICT DO NOTHING` and only the rows actually inserted are
  announced, so two overlapping ticks cannot both claim a booking. A crash
  between claim and send drops a ping rather than duplicating one — the safer
  failure for an alert people act on.
- **Total send failure releases the claim** so the next pass retries. A partial
  failure keeps it, since re-sending would duplicate for whoever did receive it.
- **First run seeds silently.** Whatever is already on today's board is absorbed
  without pings, and you get one "bot armed" message instead.
- **Staleness gate.** A booking confirmed more than `ANNOUNCE_MAX_AGE_MINUTES`
  ago (default 30) is claimed silently. If the cron stops for hours, you get
  quiet catch-up rather than a wall of stale alerts.

---

## Commands

| command | who | does |
|---|---|---|
| `/today` | allowlisted | today's `new` + `scheduled` bookings, each with a deep link, plus a footer counting the rest of the board |
| `/id` | anyone | prints the chat id, so it can be allowlisted |
| `/help`, `/start` | anyone | usage |

`/today`'s footer matters: bookings leave `new`/`scheduled` quickly, so by
afternoon that list is legitimately empty and the footer is what shows the day
actually happened.

---

## Local development

```bash
bun install
cp .env.example .env.local   # fill it in
bun run dev                  # http://localhost:3100
```

Verify the backend read and the rendering without sending anything or writing
to Supabase:

```bash
curl -s "http://localhost:3100/api/poll?secret=$CRON_SECRET&dry=1" | jq
```

`dry=1` returns the fully rendered message for every booking a real pass would
announce, plus the `/today` preview. It claims nothing and sends nothing, and
tolerates an unconfigured Supabase.

```bash
bun run typecheck
bun run build
```

## Routes

| route | auth | purpose |
|---|---|---|
| `GET\|POST /api/poll` | `Bearer $CRON_SECRET` or `?secret=` | the cron tick; `?dry=1` to preview |
| `POST /api/telegram` | `X-Telegram-Bot-Api-Secret-Token` | webhook. Without this header check the endpoint would be a public message sender |
| `GET /api/health` | none | liveness |

## Operational notes

- The CTA deep-links to `<ADMIN_PANEL_URL>/requests?id=<uuid>`. That page
  defaults its date filter to **today** and opens the drawer for `?id=`, so the
  link lands on the booking for exactly the bookings this bot reports. Caveat:
  the panel's hub selector is **sticky per browser** — if a user has a single
  hub pinned, a booking from another hub will not be in their loaded list and
  the drawer will not open. The hub name is in every message so this is at least
  visible. Switching the panel to "All hubs" once fixes it.
- This repo only ever issues `GET`s against the FamCare backend plus
  `POST /admin/login`. It cannot modify a booking.
