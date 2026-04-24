import { z } from "zod";

const envSchema = z.object({
  // Supabase — required
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // AI providers — required
  OPENAI_API_KEY: z.string().min(1),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),

  // Supabase sandbox — optional
  SUPABASE_SANDBOX_DB_URL: z.string().url().optional(),

  // Model overrides — optional with defaults
  MODEL_CHAT: z.string().default("gpt-4o-mini"),
  MODEL_EVAL: z.string().default("gpt-4o"),
  MODEL_SQL: z.string().default("gemini-2.0-flash"),
  MODEL_VISION: z.string().default("gemini-2.0-flash"),
  MODEL_EMBEDDINGS: z.string().default("text-embedding-3-small"),

  // Session/flow config — optional with defaults
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(6),
  FLOW_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),

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
