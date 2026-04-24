import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

let _supabaseAdmin: SupabaseClient<Database> | undefined;

/**
 * Factory that always returns a fresh Supabase admin client.
 * Use this when you need per-request isolation; otherwise prefer the
 * module-level singleton `supabaseAdmin`.
 */
export function createServerClient(): SupabaseClient<Database> {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

/**
 * Lazy singleton Supabase admin client for server-side use only.
 * NEVER expose SUPABASE_SERVICE_ROLE_KEY or this client to the browser.
 */
export const supabaseAdmin: SupabaseClient<Database> = new Proxy(
  {} as SupabaseClient<Database>,
  {
    get(_target, prop: string | symbol) {
      if (_supabaseAdmin === undefined) {
        _supabaseAdmin = createServerClient();
      }
      const value = (_supabaseAdmin as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value === "function") {
        return (value as Function).bind(_supabaseAdmin);
      }
      return value;
    },
  },
);
