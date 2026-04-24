/**
 * sql-sandbox.ts
 *
 * Mastra tool: consulta_analitica_sql
 *
 * Executes a read-only SELECT query against the Supabase analytics sandbox
 * database via the sql_sandbox Postgres role.  Every invocation is logged to
 * public.unanswered_questions regardless of outcome.
 *
 * Security layers:
 *  1. Regex-based SQL validator (no DML, only v_* views, single statement).
 *  2. Per-transaction SET LOCAL statement_timeout + transaction_read_only.
 *  3. Connection pool pointing at SUPABASE_SANDBOX_DB_URL (role sql_sandbox).
 *  4. Resultset hard-capped at 50 rows.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Lazy Postgres pool — only instantiated when SUPABASE_SANDBOX_DB_URL exists.
// We import dynamically so the module loads without crashing when the package
// has not been installed yet.
// ---------------------------------------------------------------------------

type SqlTag = (
  template: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PostgresInstance = any;

let _sql: PostgresInstance | null | undefined = undefined; // undefined = not resolved yet

async function getSql(): Promise<PostgresInstance | null> {
  if (_sql !== undefined) return _sql;

  const url = process.env["SUPABASE_SANDBOX_DB_URL"];
  if (!url) {
    _sql = null;
    return null;
  }

  try {
    // Dynamic import so the module works even when 'postgres' is absent in dev.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("postgres");
    const postgres = (mod.default ?? mod) as (
      url: string,
      opts: Record<string, unknown>
    ) => PostgresInstance;
    _sql = postgres(url, { max: 5, idle_timeout: 30 });
  } catch {
    _sql = null;
  }
  return _sql;
}

// ---------------------------------------------------------------------------
// SQL Validator
// ---------------------------------------------------------------------------

const DML_PATTERN =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|copy|truncate|begin|commit|rollback|do|call|merge)\b/i;

const VIEW_REF_PATTERN = /\b(from|join)\s+(public\.)?v_\w+\b/i;

const LIMIT_PATTERN = /\bLIMIT\s+(\d+)\b/i;

/**
 * Strip SQL single-line and block comments.
 */
function stripComments(sql: string): string {
  // Block comments first (/* ... */)
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Single-line comments (-- ...)
  s = s.replace(/--[^\n]*/g, " ");
  return s;
}

/**
 * Returns either the sanitised / LIMIT-injected SQL string, or throws with a
 * human-readable rejection reason.
 */
function validateAndNormaliseSql(rawSql: string): string {
  const stripped = stripComments(rawSql).trim();

  // 1. Reject DML / DDL / transaction keywords.
  if (DML_PATTERN.test(stripped)) {
    throw new Error(
      "La consulta contiene operaciones no permitidas (INSERT, UPDATE, DROP, etc.)"
    );
  }

  // 2. Only one statement allowed — split on semicolons, filter empty segments.
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length > 1) {
    throw new Error("Solo se permite una sentencia SQL por llamada.");
  }

  const singleStatement = statements[0];
  if (!singleStatement) {
    throw new Error("La consulta está vacía.");
  }

  // 3. Must start with SELECT or WITH.
  const firstToken = singleStatement.match(/^\s*(\w+)/)?.[1]?.toUpperCase();
  if (firstToken !== "SELECT" && firstToken !== "WITH") {
    throw new Error(
      "Solo se permiten consultas SELECT o WITH (CTEs). La consulta debe comenzar con SELECT o WITH."
    );
  }

  // 4. Must reference at least one v_* view.
  if (!VIEW_REF_PATTERN.test(singleStatement)) {
    throw new Error(
      "La consulta debe hacer referencia a al menos una vista (v_*) del esquema público. " +
        "Las tablas crudas no están disponibles en el sandbox."
    );
  }

  // 5. LIMIT handling — inject if absent, cap at 100 if present.
  const limitMatch = singleStatement.match(LIMIT_PATTERN);
  if (!limitMatch) {
    // No LIMIT — append one.
    return singleStatement.replace(/;?\s*$/, "") + " LIMIT 100";
  }

  const requestedLimit = parseInt(limitMatch[1] ?? "0", 10);
  if (requestedLimit > 100) {
    // Cap the existing LIMIT.
    return singleStatement.replace(LIMIT_PATTERN, "LIMIT 100");
  }

  return singleStatement;
}

// Exported for unit testing only.
export { validateAndNormaliseSql };

// ---------------------------------------------------------------------------
// Audit logger — fire-and-forget, never throws.
// ---------------------------------------------------------------------------

async function logAttempt(opts: {
  razon: string;
  sql_generated: string;
  resolution: "sql_ok" | "sql_fail";
  rows_returned?: number;
}): Promise<void> {
  try {
    await supabaseAdmin.from("unanswered_questions").insert({
      question: opts.razon,
      sql_generated: opts.sql_generated,
      resolution: opts.resolution,
    });
  } catch {
    // Intentionally swallowed — audit must never break the main flow.
  }
}

// ---------------------------------------------------------------------------
// Tool input / output schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  sql: z.string().min(1).describe("Sentencia SQL SELECT a ejecutar."),
  razon: z
    .string()
    .min(1)
    .describe(
      "Motivo o pregunta original del usuario que originó esta consulta SQL."
    ),
});

const SuccessOutputSchema = z.object({
  ok: z.literal(true),
  rows: z.array(z.record(z.unknown())),
  columns: z.array(z.string()),
  sql_ejecutado: z.string(),
  row_count: z.number(),
});

const ErrorOutputSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

const OutputSchema = z.union([SuccessOutputSchema, ErrorOutputSchema]);

type ToolOutput = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const consulta_analitica_sql = createTool({
  id: "consulta_analitica_sql",
  description:
    "Ejecuta una consulta SQL analítica de solo lectura (SELECT) contra " +
    "las vistas públicas del sandbox de la base de datos de la Alcaldía Cuauhtémoc. " +
    "Solo acepta consultas que hagan referencia a vistas v_* del esquema público. " +
    "DML (INSERT, UPDATE, DELETE, DROP, etc.) es rechazado. " +
    "El resultado se limita a 50 filas.",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  execute: async (input): Promise<ToolOutput> => {
    const { sql: rawSql, razon } = input;

    // ------------------------------------------------------------------
    // Step 1: Check sandbox connectivity.
    // ------------------------------------------------------------------
    const sql = await getSql();
    if (!sql) {
      return { ok: false, error: "sandbox not configured" };
    }

    // ------------------------------------------------------------------
    // Step 2: Validate & normalise the SQL.
    // ------------------------------------------------------------------
    let normalisedSql: string;
    try {
      normalisedSql = validateAndNormaliseSql(rawSql);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await logAttempt({
        razon,
        sql_generated: rawSql,
        resolution: "sql_fail",
      });
      return { ok: false, error: errorMsg };
    }

    // ------------------------------------------------------------------
    // Step 3: Execute inside a read-only transaction with timeouts.
    // ------------------------------------------------------------------
    try {
      // We use a transaction so that SET LOCAL is scoped to this query only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: Record<string, unknown>[] = await (sql as any).begin(
        async (tx: { unsafe: SqlTag }) => {
          await tx.unsafe`SET LOCAL statement_timeout = '3s'`;
          await tx.unsafe`SET LOCAL transaction_read_only = on`;
          return tx.unsafe`${normalisedSql}` as Promise<
            Record<string, unknown>[]
          >;
        }
      );

      // ------------------------------------------------------------------
      // Step 4: Truncate to 50 rows.
      // ------------------------------------------------------------------
      const truncated = rows.slice(0, 50);
      const columns =
        truncated.length > 0 ? Object.keys(truncated[0] ?? {}) : [];

      await logAttempt({
        razon,
        sql_generated: normalisedSql,
        resolution: "sql_ok",
        rows_returned: truncated.length,
      });

      return {
        ok: true,
        rows: truncated,
        columns,
        sql_ejecutado: normalisedSql,
        row_count: truncated.length,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await logAttempt({
        razon,
        sql_generated: normalisedSql,
        resolution: "sql_fail",
      });
      return { ok: false, error: `Error al ejecutar la consulta: ${errorMsg}` };
    }
  },
});
