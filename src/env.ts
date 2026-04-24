import { z } from "zod";

const envSchema = z.object({
  // Supabase — required at boot
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  // Service role is needed by every server-side query but we accept empty here so
  // dev server can boot. The supabase-server client throws on first use if missing.
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),

  // OpenRouter — required (single endpoint for all model traffic)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),

  // OpenRouter analytics headers — optional with defaults
  HTTP_REFERER: z.string().default("https://alcaldia-cuauhtemoc.local"),
  APP_TITLE: z.string().default("Alessandra · Alcaldía Cuauhtémoc"),

  // AI providers — now OPTIONAL (kept for direct-provider bypass if needed)
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

  // Supabase sandbox — optional
  SUPABASE_SANDBOX_DB_URL: z.string().url().optional(),

  // Model overrides — optional with defaults (OpenRouter slugs)
  MODEL_ROUTER: z.string().default("openai/gpt-4o-mini"),
  MODEL_MAIN: z.string().default("openai/gpt-4o-mini"),
  MODEL_CHAT: z.string().default("openai/gpt-4o-mini"),
  MODEL_EVAL: z.string().default("openai/gpt-4o"),
  MODEL_SQL: z.string().default("openai/gpt-4o"),
  MODEL_EXTRACTION: z.string().default("openai/gpt-4o-mini"),
  MODEL_VISION: z.string().default("google/gemini-2.0-flash-exp:free"),
  MODEL_EMBEDDINGS: z.string().default("text-embedding-3-small"),

  // Session/flow config — optional with defaults
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(6),
  FLOW_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),

  // Twilio — required for the WhatsApp webhook (/api/whatsapp/webhook).
  // Marked optional at schema level so the dev server still boots on repos
  // without Twilio configured; the webhook route re-checks at request time.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().default("whatsapp:+14155238886"),
  // Public base URL for the Twilio webhook (e.g. https://abc.trycloudflare.com).
  // Required when running behind a tunnel or reverse proxy so that Twilio
  // signature validation uses the public HTTPS URL Twilio signed, not the
  // internal localhost URL that Next.js sees on req.url.
  TWILIO_WEBHOOK_BASE_URL: z.string().url().optional(),

  // Node env — optional
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

function getEnv(): Env {
  if (_env === undefined) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
