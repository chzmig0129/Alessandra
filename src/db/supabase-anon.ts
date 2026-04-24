import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

/**
 * Singleton Supabase client using the public anon key.
 * Safe for client-side use — respects Row Level Security policies.
 */
export const supabaseAnon: SupabaseClient<Database> = createClient<Database>(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
