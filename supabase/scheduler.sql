-- ===========================================================================
-- Drive the bot's poll loop from Postgres instead of Vercel cron.
--
-- Why: Vercel Hobby runs cron jobs ONCE A DAY no matter what expression is in
-- vercel.json, which is useless for a booking alert. Supabase already ships
-- pg_cron (scheduling) and pg_net (outbound HTTP), so the database you are
-- already paying nothing for can call the route on a tight interval.
--
-- Run in the Supabase SQL editor AFTER schema.sql, once the app is deployed.
-- Replace the two placeholders below, then run the whole file. It is
-- idempotent: re-running it updates the secrets and replaces the job.
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $outer$
declare
    -- >>> EDIT THESE TWO <<<
    poll_url    text := 'https://<your-deployment>.vercel.app/api/poll';
    cron_secret text := '<your CRON_SECRET>';

    sid         uuid;
    ver         text;
    parts       int[];
    sub_minute  boolean;
    sched       text;
    passes      text;
    tmo         text;
    cmd         text;
begin
    -- ---------------------------------------------------------------------
    -- Secrets live in Vault, not inline in the cron command, where they would
    -- sit in cleartext in cron.job for anyone with database access to read.
    -- Upserted so re-running after a redeploy just moves the URL.
    -- ---------------------------------------------------------------------
    select id into sid from vault.secrets where name = 'booking_bot_poll_url';
    if sid is null then
        perform vault.create_secret(poll_url, 'booking_bot_poll_url',
                                    'Poll endpoint for the FamCare booking bot');
    else
        perform vault.update_secret(sid, poll_url);
    end if;

    select id into sid from vault.secrets where name = 'booking_bot_cron_secret';
    if sid is null then
        perform vault.create_secret(cron_secret, 'booking_bot_cron_secret',
                                    'Bearer token the bot poll route requires');
    else
        perform vault.update_secret(sid, cron_secret);
    end if;

    -- ---------------------------------------------------------------------
    -- Pick the cadence from what this pg_cron can actually do.
    --
    -- >= 1.5 supports second-level schedules, so the SCHEDULER sets the pace
    -- and each request stays short (passes=1), comfortably inside pg_net's
    -- response timeout.
    --
    -- Older than that has a one-minute floor, so the ROUTE supplies the
    -- sub-minute cadence instead (passes=4, ~45s open) and pg_net must be
    -- told to wait that long.
    -- ---------------------------------------------------------------------
    select extversion into ver from pg_extension where extname = 'pg_cron';
    parts      := string_to_array(ver, '.')::int[];
    sub_minute := parts[1] > 1
                  or (parts[1] = 1 and coalesce(parts[2], 0) >= 5);

    if sub_minute then
        sched := '15 seconds'; passes := '1'; tmo := '20000';
    else
        sched := '* * * * *';  passes := '4'; tmo := '58000';
    end if;

    cmd := format($cmd$
        select net.http_post(
            url     := (select decrypted_secret from vault.decrypted_secrets
                         where name = 'booking_bot_poll_url') || '?passes=%s',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' ||
                    (select decrypted_secret from vault.decrypted_secrets
                      where name = 'booking_bot_cron_secret')),
            body    := '{}'::jsonb,
            timeout_milliseconds := %s);
    $cmd$, passes, tmo);

    -- Replace rather than duplicate, so re-running cannot leave two jobs
    -- both ticking.
    perform cron.unschedule('famcare-booking-bot-poll')
      where exists (select 1 from cron.job
                     where jobname = 'famcare-booking-bot-poll');

    perform cron.schedule('famcare-booking-bot-poll', sched, cmd);

    raise notice 'pg_cron % detected -> schedule "%", passes=%, timeout=%ms',
                 ver, sched, passes, tmo;
end
$outer$;

-- ===========================================================================
-- Verify. Wait ~30 seconds after the above, then run this.
--
-- status_code 200 = ticks are landing.
-- 401            = the Vault secret and Vercel's CRON_SECRET disagree.
-- no rows        = cron is not firing at all.
--
-- NOTE: cron.job_run_details only proves the SQL ran, i.e. that the request
-- was queued. The HTTP outcome is in pg_net's own table.
-- ===========================================================================
-- select jobid, jobname, schedule, active from cron.job;
--
-- select id, status_code, error_msg, created
--   from net._http_response order by created desc limit 10;

-- Pause / resume / remove:
--   update cron.job set active = false where jobname = 'famcare-booking-bot-poll';
--   update cron.job set active = true  where jobname = 'famcare-booking-bot-poll';
--   select cron.unschedule('famcare-booking-bot-poll');

-- Housekeeping, optional:
--   select cron.schedule('famcare-bot-prune-http', '23 4 * * *',
--     $$ delete from net._http_response where created < now() - interval '2 days' $$);
--   select cron.schedule('famcare-bot-prune-ledger', '17 3 * * *',
--     $$ delete from notified_bookings where service_date < current_date - 14 $$);
