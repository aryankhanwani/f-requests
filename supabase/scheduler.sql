-- ===========================================================================
-- Drive the bot's poll loop from Postgres instead of Vercel cron.
--
-- Why: Vercel Hobby runs cron jobs ONCE A DAY no matter what expression is in
-- vercel.json, which is useless for a booking alert. Supabase already ships
-- pg_cron (scheduling) and pg_net (outbound HTTP), so the database you are
-- already paying nothing for can call the route on a tight interval.
--
-- Run this in the Supabase SQL editor AFTER schema.sql, and after the app is
-- deployed (you need its URL).
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- 1. Store the endpoint + secret in Vault rather than inlining them into the
--    cron command, where they would sit in cleartext in cron.job for anyone
--    with database access to read.
-- ---------------------------------------------------------------------------
select vault.create_secret(
    'https://<your-deployment>.vercel.app/api/poll',
    'booking_bot_poll_url',
    'Poll endpoint for the FamCare booking bot'
);

select vault.create_secret(
    '<your CRON_SECRET>',
    'booking_bot_cron_secret',
    'Bearer token the bot poll route requires'
);

-- Re-run these instead if the secrets already exist:
-- select vault.update_secret(
--     (select id from vault.secrets where name = 'booking_bot_poll_url'),
--     'https://<new-url>/api/poll');

-- ---------------------------------------------------------------------------
-- 2. The tick.
--
--    passes=1 keeps each request short (a second or two), so it finishes well
--    inside pg_net's response timeout. Frequency comes from pg_cron, not from
--    the route holding itself open.
--
--    SUB-MINUTE SCHEDULING NEEDS pg_cron >= 1.5. Check with:
--        select extversion from pg_extension where extname = 'pg_cron';
--    If it is older than 1.5, use the one-minute variant in section 3 instead.
-- ---------------------------------------------------------------------------
select cron.schedule(
    'famcare-booking-bot-poll',
    '15 seconds',
    $$
    select net.http_post(
        url     := (select decrypted_secret from vault.decrypted_secrets
                     where name = 'booking_bot_poll_url') || '?passes=1',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' ||
                (select decrypted_secret from vault.decrypted_secrets
                  where name = 'booking_bot_cron_secret')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 20000
    );
    $$
);

-- ---------------------------------------------------------------------------
-- 3. Fallback for pg_cron < 1.5 (one-minute floor).
--
--    Here the ROUTE provides the sub-minute cadence instead: 4 passes spaced
--    15s apart, so the request stays open ~45s. The pg_net timeout must cover
--    that, otherwise pg_net logs a timeout every single minute.
--
--    Drop the job above first:  select cron.unschedule('famcare-booking-bot-poll');
-- ---------------------------------------------------------------------------
-- select cron.schedule(
--     'famcare-booking-bot-poll',
--     '* * * * *',
--     $$
--     select net.http_post(
--         url     := (select decrypted_secret from vault.decrypted_secrets
--                      where name = 'booking_bot_poll_url') || '?passes=4',
--         headers := jsonb_build_object(
--             'Content-Type', 'application/json',
--             'Authorization', 'Bearer ' ||
--                 (select decrypted_secret from vault.decrypted_secrets
--                   where name = 'booking_bot_cron_secret')
--         ),
--         body    := '{}'::jsonb,
--         timeout_milliseconds := 58000
--     );
--     $$
-- );

-- ===========================================================================
-- Operating it
-- ===========================================================================

-- Is the job registered?
--   select jobid, jobname, schedule, active from cron.job;

-- Did the ticks fire, and did they succeed?
--   select start_time, status, return_message
--     from cron.job_run_details
--    where jobname = 'famcare-booking-bot-poll'
--    order by start_time desc limit 20;
--
-- NOTE: status='succeeded' there only means the SQL ran, i.e. the HTTP request
-- was queued. The HTTP outcome lives in pg_net's own response table:
--
--   select id, status_code, error_msg, created
--     from net._http_response
--    order by created desc limit 20;
--
-- 200 = a real tick. 401 = the Vault secret does not match CRON_SECRET on
-- Vercel. Timeouts = raise timeout_milliseconds or lower ?passes=.

-- pg_net keeps responses for a short window; prune if it grows.
--   select cron.schedule('famcare-bot-prune-http',
--                        '23 4 * * *',
--                        $$ delete from net._http_response
--                            where created < now() - interval '2 days' $$);

-- Pause / resume / remove:
--   update cron.job set active = false where jobname = 'famcare-booking-bot-poll';
--   update cron.job set active = true  where jobname = 'famcare-booking-bot-poll';
--   select cron.unschedule('famcare-booking-bot-poll');
