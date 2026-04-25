import postgres, { type Sql } from "postgres";
import "dotenv/config";

const mundialUrl = process.env.SUPABASE_DB_URL;
if (!mundialUrl) {
  throw new Error("SUPABASE_DB_URL no está definido en .env");
}

const alessandraUrl = process.env.SUPABASE_DB_URL_ALESSANDRA;

function buildPool(connectionString: string, searchPath: string): Sql {
  return postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    connection: { search_path: searchPath },
    ssl: connectionString.includes("sslmode=") ? undefined : "require",
  });
}

// Pool para el dominio Mundial (schema "mundial-fifa", requiere comillas dobles).
export const mundialSql = buildPool(mundialUrl, '"mundial-fifa", public');

// Alias retrocompatible con el código existente del bot del Mundial.
export const sql = mundialSql;

// Pool para el dominio Alessandra (schema public). Lazy: si no está la env, falla solo cuando alguien lo use.
let _alessandraSql: Sql | null = null;
export function alessandraSql(): Sql {
  if (!_alessandraSql) {
    if (!alessandraUrl) {
      throw new Error(
        "SUPABASE_DB_URL_ALESSANDRA no está definido en .env (necesario para tools de Alessandra)"
      );
    }
    _alessandraSql = buildPool(alessandraUrl, "public");
  }
  return _alessandraSql;
}

// Palabras prohibidas: cualquier cosa que mute estado.
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "truncate",
  "create",
  "grant",
  "revoke",
  "copy",
  "set",
  "reset",
  "call",
  "do",
  "comment",
  "vacuum",
  "analyze",
  "lock",
  "refresh",
  "merge",
];

function stripStringsAndComments(s: string): string {
  return s
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, "''");
}

export function validateSelectOnly(rawSql: string): void {
  const trimmed = rawSql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("SQL vacío");

  if (trimmed.includes(";")) {
    throw new Error("Multiple statements no permitidos");
  }

  const code = stripStringsAndComments(trimmed).toLowerCase();

  if (!/^\s*(select|with)\b/.test(code)) {
    throw new Error("Solo se permiten queries SELECT o WITH...SELECT");
  }

  for (const kw of FORBIDDEN) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(code)) {
      throw new Error(`SQL contiene keyword prohibida: ${kw.toUpperCase()}`);
    }
  }
}

function ensureLimit(rawSql: string, defaultLimit = 100): string {
  const trimmed = rawSql.trim().replace(/;+\s*$/, "");
  const code = stripStringsAndComments(trimmed).toLowerCase();
  if (/\blimit\s+\d+/.test(code)) return trimmed;
  return `${trimmed} LIMIT ${defaultLimit}`;
}

export async function executeReadOnlyQuery<T = Record<string, unknown>>(
  rawSql: string,
  timeoutMs = 3000,
  pool: Sql = mundialSql
): Promise<T[]> {
  validateSelectOnly(rawSql);
  const safeSql = ensureLimit(rawSql, 100);

  const rows = await pool.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(100, timeoutMs)}`);
    const result = await tx.unsafe(safeSql);
    return result;
  });
  return rows as unknown as T[];
}
