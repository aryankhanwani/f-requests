import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { dryRun, runPass, type PassResult } from "@/lib/notify";

export const dynamic = "force-dynamic";
// Vercel's cron floor is one minute, so a single invocation runs several passes
// spaced a few seconds apart. That brings worst-case latency down to roughly
// POLL_PASS_INTERVAL_MS instead of a full minute, with no extra infrastructure.
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

  // Renders what would be sent, without claiming or sending anything.
  if (new URL(req.url).searchParams.get("dry") === "1") {
    return NextResponse.json(await dryRun());
  }

  const started = Date.now();
  const passes: PassResult[] = [];
  const errors: string[] = [];

  // Leave headroom so a slow final pass cannot blow the function timeout.
  const budgetMs = (maxDuration - 8) * 1000;

  for (let i = 0; i < env.passesPerInvocation; i++) {
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
