import "server-only";

/** Reads a required env var, failing loudly at first use rather than silently
 *  sending half-configured messages. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  // FamCare backend. Prod default; point at the staging path to dry-run.
  get apiBaseUrl() {
    return process.env.FAMCARE_API_BASE_URL ?? "https://backend.fixxoit.com/api";
  },
  get adminUsername() {
    return required("FAMCARE_ADMIN_USERNAME");
  },
  get adminPassword() {
    return required("FAMCARE_ADMIN_PASSWORD");
  },

  // Where the CTA points. Must be the panel origin, no trailing slash.
  get adminPanelUrl() {
    return (process.env.ADMIN_PANEL_URL ?? "https://admin.fixxoit.com").replace(
      /\/+$/,
      "",
    );
  },

  get telegramBotToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  /** Shared secret Telegram echoes back on every webhook delivery. */
  get telegramWebhookSecret() {
    return required("TELEGRAM_WEBHOOK_SECRET");
  },

  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },

  /** Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations. */
  get cronSecret() {
    return required("CRON_SECRET");
  },

  // One cron tick runs several passes so latency beats the 1-minute cron floor.
  get passesPerInvocation() {
    return optionalInt("POLL_PASSES_PER_INVOCATION", 4);
  },
  get passIntervalMs() {
    return optionalInt("POLL_PASS_INTERVAL_MS", 15_000);
  },

  /** A booking confirmed longer ago than this is claimed silently instead of
   *  pinged. Stops a backlog blast after downtime without ever suppressing a
   *  genuinely fresh booking. */
  get announceMaxAgeMinutes() {
    return optionalInt("ANNOUNCE_MAX_AGE_MINUTES", 30);
  },
};

export const IST = "Asia/Kolkata";
