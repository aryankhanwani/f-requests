-- FamCare booking bot — Supabase schema.
-- Run this once in the Supabase SQL editor.
--
-- Two tables only, per the brief: an allowlist of who may receive/query, and a
-- claim ledger so a booking is never announced twice (the poll route can be
-- invoked concurrently by cron and by hand).

-- ---------------------------------------------------------------------------
-- Who is allowed to talk to / be pinged by the bot.
-- chat_id is the Telegram chat the message goes to. For a 1:1 chat it equals
-- the user id; for a group it is the (negative) group id. Both work.
-- ---------------------------------------------------------------------------
create table if not exists bot_allowlist (
    chat_id     bigint primary key,
    label       text,
    is_active   boolean     not null default true,
    created_at  timestamptz not null default now()
);

comment on table bot_allowlist is
    'Telegram chats permitted to receive booking pings and run bot commands.';

-- ---------------------------------------------------------------------------
-- Claim ledger. A row here means "this booking has been announced".
-- The poll route INSERTs first and sends second, so a crash mid-send loses a
-- notification rather than sending it twice — the safer failure for an alert
-- channel that people act on.
--
-- status is recorded so a later new -> scheduled transition can be told apart
-- from a brand-new booking if that is ever wanted; today it is informational.
-- ---------------------------------------------------------------------------
create table if not exists notified_bookings (
    request_id    uuid primary key,
    status        text        not null,
    service_date  date        not null,
    scheduled_at  timestamptz,
    created_at    timestamptz,
    amount_paise  integer,
    announced     boolean     not null default false,
    notified_at   timestamptz not null default now()
);

comment on table notified_bookings is
    'One row per booking the bot has claimed. announced=false means it was '
    'absorbed by the initial silent seed rather than pinged.';

-- service_date is what the daily /today command and the housekeeping delete
-- filter on.
create index if not exists notified_bookings_service_date_idx
    on notified_bookings (service_date);

-- ---------------------------------------------------------------------------
-- Small key/value for bot state (currently just the seeded marker).
-- ---------------------------------------------------------------------------
create table if not exists bot_state (
    key        text primary key,
    value      jsonb       not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: the bot connects with the service-role key, which bypasses RLS. Enable
-- it anyway so that if the anon key ever leaks into a client, these tables are
-- not readable.
-- ---------------------------------------------------------------------------
alter table bot_allowlist      enable row level security;
alter table notified_bookings  enable row level security;
alter table bot_state          enable row level security;

-- ---------------------------------------------------------------------------
-- Seed yourself in. Get your chat id by messaging the bot /id.
-- ---------------------------------------------------------------------------
-- insert into bot_allowlist (chat_id, label) values (123456789, 'Aryan')
--   on conflict (chat_id) do update set is_active = true;

-- ---------------------------------------------------------------------------
-- Housekeeping: the ledger only needs to cover dates the bot might re-see.
-- Optional — requires pg_cron.
-- ---------------------------------------------------------------------------
-- select cron.schedule(
--   'famcare-bot-ledger-prune',
--   '17 3 * * *',
--   $$ delete from notified_bookings where service_date < current_date - 14 $$
-- );
