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

`supabase/scheduler.sql` is separate and comes later — see step 4.

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
(negative) group id instead. Note that a bot cannot be added to groups unless
that is enabled — in BotFather, `/setjoingroups` → Enable. Group privacy mode
also hides plain messages from bots, but **commands always reach it**, so
`/today` works in a group without disabling privacy.

### 3. Vercel

Set every var from `.env.example` in project settings. `FAMCARE_ADMIN_*` must be
a **superadmin** account — `GET /admin/requests` derives hub scope from the
token, so a hub admin would only ever see their own hub's bookings.

### 4. The scheduler — read this, it depends on your plan

**Vercel Hobby runs cron jobs once a day**, whatever expression is in
`vercel.json`. A once-daily tick is useless for a booking alert, so on Hobby the
schedule must come from somewhere else.

`vercel.json` therefore ships a deliberately **daily** tick, which behaves the
same on both plans and acts as a harmless safety net. Pick your real driver:

#### Hobby — drive it from Supabase (recommended, no new accounts)

Supabase already ships `pg_cron` and `pg_net`, so Postgres can call the route
itself. Run `supabase/scheduler.sql`, filling in your deployment URL and
`CRON_SECRET`. It stores both in Supabase Vault rather than inlining them into
`cron.job`, schedules a tick every 15 seconds, and calls the route with
`?passes=1` so each request returns in a second or two.

Sub-minute scheduling needs `pg_cron >= 1.5`. Check it:

```sql
select extversion from pg_extension where extname = 'pg_cron';
```

If it is older, the file has a commented one-minute variant that uses
`?passes=4` instead — the route then supplies the sub-minute cadence itself, for
the same ~15s worst case.

Verify ticks are landing — note that `cron.job_run_details` only proves the SQL
ran, not that the HTTP call succeeded. The HTTP status is in pg_net:

```sql
select id, status_code, error_msg, created
  from net._http_response order by created desc limit 20;
```

`200` is a real tick. `401` means the Vault secret and Vercel's `CRON_SECRET`
disagree.

#### Pro — use Vercel cron

Change `vercel.json` to `"schedule": "* * * * *"` and you are done. One
invocation then runs `POLL_PASSES_PER_INVOCATION` passes (default 4 × 15s) to
beat the one-minute floor. Vercel injects `CRON_SECRET` as
`Authorization: Bearer $CRON_SECRET` automatically.

#### Any other scheduler

The route accepts the secret as a query param too, so anything that can fetch a
URL works — cron-job.org, Upstash QStash, a Cloudflare Worker cron, a box with
crontab:

```
* * * * * curl -fsS "https://<deployment>/api/poll?secret=$CRON_SECRET&passes=4" >/dev/null
```

Avoid GitHub Actions for this. Its scheduled runs are queued, not guaranteed,
and routinely drift ten minutes or more.

## Latency: why polling, not SSE

The backend has a real push channel — `GET /admin/events`, a Server-Sent Events
stream that broadcasts `new_request` **at payment capture** (scheduled bookings
from `payments/service.py:1168`, instant ones from
`process_assignment_for_request`). That is a true sub-second signal.

A Vercel function cannot hold a long-lived stream open, so this build polls
instead, and `?passes=` lets one route serve either cadence model:

| driver | call | why |
|---|---|---|
| pg_cron every 15s | `?passes=1` | frequency comes from the scheduler; each request is short |
| cron every 60s | `?passes=4` | frequency comes from the route, which stays open ~45s |

Either way worst-case latency is ~15s rather than ~60s. See
[the scheduler section](#4-the-scheduler--read-this-it-depends-on-your-plan).

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

To prove the **Telegram** side end to end before deploying anything — token,
HTML rendering, CTA button — press Start on the bot in Telegram, then:

```bash
# 1. find your chat id (works only while no webhook is registered)
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | jq '.result[].message.chat.id'

# 2. send yourself a real booking, formatted exactly as a live ping
curl -s "http://localhost:3100/api/poll?secret=$CRON_SECRET&test=<chat_id>"
```

`test=` ignores the allowlist and the ledger, so it neither marks a booking as
announced nor requires you to be allowlisted yet. It is still behind
`CRON_SECRET`.

```bash
bun run typecheck
bun run build
```

## Routes

| route | auth | purpose |
|---|---|---|
| `GET\|POST /api/poll` | `Bearer $CRON_SECRET` or `?secret=` | the cron tick. `?passes=N` sets passes per call, `?dry=1` previews without sending, `?test=<chat_id>` sends one real sample ping |
| `POST /api/telegram` | `X-Telegram-Bot-Api-Secret-Token` | webhook. Without this header check the endpoint would be a public message sender |
| `GET /api/health` | none | liveness |

## Resetting the first-run seed

The first tick absorbs today's board silently and writes `bot_state.seeded`, so
it only ever happens once. To replay it — e.g. to see the "bot armed" greeting
after allowlisting yourself — clear both:

```sql
delete from bot_state where key = 'seeded';
delete from notified_bookings where service_date = (now() at time zone 'Asia/Kolkata')::date;
```

Harmless: the next tick re-absorbs the same bookings and greets you.

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
