import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { dryRun, runPass, sendTestPing, type PassResult } from "@/lib/notify";

export const dynamic = "force-dynamic";
// Two supported cadence models, both served by this one route:
//
//  - Scheduler can only fire once a minute (Vercel Pro cron): one invocation
//    runs several passes spaced POLL_PASS_INTERVAL_MS apart, so latency is the
//    interval rather than a full minute. This is what holds the function open.
//  - Scheduler can fire every few seconds (Supabase pg_cron, needed on Vercel
//    Hobby where cron only runs daily): call with ?passes=1 so each request
//    returns in a second or two, well inside pg_net's response timeout.
//
// 60s is also the Hobby function ceiling, so it is the safe upper bound.
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization");
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically.
  if (header === `Bearer ${env.cronSecret}`) return true;
  // Also accept ?secret= so the route can be triggered by hand or by an
  // external scheduler that cannot set headers.
  const url = new URL(req.url);
  return url.searchParams.get("secret") === env.cronSecret;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;

  // Renders what would be sent, without claiming or sending anything.
  if (params.get("dry") === "1") {
    return NextResponse.json(await dryRun());
  }

  // Sends one real sample ping to an explicit chat id, ignoring the allowlist
  // and the ledger. For verifying the Telegram side end to end.
  const test = params.get("test");
  if (test) {
    const chatId = Number(test);
    if (!Number.isInteger(chatId)) {
      return NextResponse.json(
        { error: "test must be a numeric Telegram chat id" },
        { status: 400 },
      );
    }
    return NextResponse.json(await sendTestPing(chatId));
  }

  const started = Date.now();
  const passes: PassResult[] = [];
  const errors: string[] = [];

  // Leave headroom so a slow final pass cannot blow the function timeout.
  const budgetMs = (maxDuration - 8) * 1000;

  // ?passes=N lets the caller pick the cadence model without a redeploy.
  const requested = Number(params.get("passes"));
  const passCount =
    Number.isFinite(requested) && requested >= 1
      ? Math.min(Math.trunc(requested), 10)
      : env.passesPerInvocation;

  for (let i = 0; i < passCount; i++) {
    if (i > 0) {
      if (Date.now() - started + env.passIntervalMs > budgetMs) break;
      await sleep(env.passIntervalMs);
    }
    try {
      passes.push(await runPass());
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  const announced = passes.reduce((s, p) => s + p.announced, 0);
  return NextResponse.json({
    ok: errors.length === 0,
    passes: passes.length,
    announced,
    claimed: passes.reduce((s, p) => s + p.claimed, 0),
    suppressed: passes.reduce((s, p) => s + p.suppressed, 0),
    scanned: passes.at(-1)?.scanned ?? 0,
    recipients: passes.at(-1)?.recipients ?? 0,
    seeded: passes.find((p) => p.seeded != null)?.seeded,
    sendFailures: passes.flatMap((p) => p.failures),
    errors,
    durationMs: Date.now() - started,
  });
}

export const GET = handle;
export const POST = handle;
