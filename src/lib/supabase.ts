import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import type { AdminRequest } from "./famcare";
import { istDate, serviceDateIst } from "./famcare";

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export interface AllowlistEntry {
  chat_id: number;
  label: string | null;
  is_active: boolean;
}

export async function activeAllowlist(): Promise<AllowlistEntry[]> {
  const { data, error } = await db()
    .from("bot_allowlist")
    .select("chat_id, label, is_active")
    .eq("is_active", true);
  if (error) throw new Error(`allowlist read failed: ${error.message}`);
  return data ?? [];
}

export async function isAllowed(chatId: number): Promise<boolean> {
  const { data, error } = await db()
    .from("bot_allowlist")
    .select("chat_id")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`allowlist check failed: ${error.message}`);
  return data !== null;
}

/** Atomically claim bookings for announcement.
 *
 *  Returns only the rows this call actually inserted. `ignoreDuplicates` turns
 *  the upsert into INSERT .. ON CONFLICT DO NOTHING, so two overlapping ticks
 *  cannot both claim the same booking — whichever loses simply gets it back
 *  filtered out of `.select()`. We claim BEFORE sending: a crash between the
 *  two drops a ping rather than duplicating one. */
export async function claimBookings(
  bookings: AdminRequest[],
  opts: { announced: boolean },
): Promise<AdminRequest[]> {
  if (bookings.length === 0) return [];

  const today = istDate();
  const rows = bookings.map((r) => ({
    request_id: r.id,
    status: r.status,
    service_date: serviceDateIst(r) ?? today,
    scheduled_at: r.scheduled_at,
    created_at: r.created_at,
    amount_paise: r.amount_inr,
    announced: opts.announced,
  }));

  const { data, error } = await db()
    .from("notified_bookings")
    .upsert(rows, { onConflict: "request_id", ignoreDuplicates: true })
    .select("request_id");
  if (error) throw new Error(`claim failed: ${error.message}`);

  const claimed = new Set((data ?? []).map((d) => d.request_id as string));
  return bookings.filter((r) => claimed.has(r.id));
}

/** Release a claim so the next pass retries it. Used when the Telegram send
 *  fails outright, so a transient API error does not silently swallow a ping. */
export async function releaseClaims(requestIds: string[]): Promise<void> {
  if (requestIds.length === 0) return;
  const { error } = await db()
    .from("notified_bookings")
    .delete()
    .in("request_id", requestIds);
  if (error) throw new Error(`release failed: ${error.message}`);
}

/** True the first time the bot ever runs. Used to absorb the existing backlog
 *  silently instead of blasting every booking already on today's board. */
export async function isSeeded(): Promise<boolean> {
  const { data, error } = await db()
    .from("bot_state")
    .select("key")
    .eq("key", "seeded")
    .maybeSingle();
  if (error) throw new Error(`state read failed: ${error.message}`);
  return data !== null;
}

export async function markSeeded(count: number): Promise<void> {
  const { error } = await db()
    .from("bot_state")
    .upsert(
      {
        key: "seeded",
        value: { at: new Date().toISOString(), absorbed: count },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  if (error) throw new Error(`state write failed: ${error.message}`);
}
