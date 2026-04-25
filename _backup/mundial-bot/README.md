# Mundial 2026 Bot

Chatbot sobre la Copa Mundial FIFA 2026 construido con [Mastra](https://mastra.ai), TypeScript y Supabase (Postgres).

El agente responde preguntas en español o inglés sobre partidos, sedes, equipos y Fan Fests consultando una base Postgres poblada. Usa text-to-SQL contra el schema `mundial-fifa` con acceso estrictamente read-only.

## Arquitectura

```
Usuario ──► Express /chat (SSE)
             │
             ▼
         Mastra Agent (gpt-5.4-mini) ──► Memory (threadId)
             │
   ┌─────────┴──────────┐
   ▼                    ▼
queryDatabase       getLiveMatchData
(text-to-SQL        (stub, API-Football
 gpt-5.4-nano)       en fase 2)
   │
   ▼
postgres.js ──► Supabase "mundial-fifa" (READ ONLY)
```

## Setup

### 1. Crear usuario Postgres read-only en Supabase

En Supabase Studio → SQL Editor ejecuta (una sola vez):

```sql
-- Ajusta la contraseña
CREATE ROLE readonly_mundial WITH LOGIN PASSWORD 'cambia-esto';

-- Permisos solo de lectura sobre el schema
GRANT USAGE ON SCHEMA "mundial-fifa" TO readonly_mundial;
GRANT SELECT ON ALL TABLES IN SCHEMA "mundial-fifa" TO readonly_mundial;
ALTER DEFAULT PRIVILEGES IN SCHEMA "mundial-fifa"
  GRANT SELECT ON TABLES TO readonly_mundial;

-- Extensión para comparaciones sin acentos (si no está ya)
CREATE EXTENSION IF NOT EXISTS unaccent;
```

### 2. Obtener la connection string directa

Project Settings → Database → **Connection string** → URI.
Reemplaza el usuario por `readonly_mundial` y la contraseña que definiste. Debe verse:

```
postgresql://readonly_mundial:password@db.xxxxx.supabase.co:5432/postgres
```

> ⚠️ No uses la URL del API REST (`https://xxx.supabase.co`). Necesitamos SQL arbitrario vía postgres.js.

### 3. Configurar variables

```bash
cp .env.example .env
# edita .env y llena OPENAI_API_KEY y SUPABASE_DB_URL
```

### 4. Instalar y correr

```bash
npm install
npm run dev
```

Abre <http://localhost:3000>.

## Comandos

| Script | Descripción |
|---|---|
| `npm run dev` | Inicia el servidor con hot-reload (tsx watch). |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Corre el build en producción. |

## Estructura

```
mundial-bot/
├── src/
│   ├── mastra/
│   │   ├── index.ts                # Registro de agentes en Mastra
│   │   ├── agents/mundialAgent.ts  # Agente principal (gpt-5.4-mini)
│   │   └── tools/
│   │       ├── queryDatabase.ts    # Text-to-SQL + ejecución read-only
│   │       └── getLiveMatchData.ts # Stub para datos en vivo
│   ├── db/client.ts                # Pool Postgres + validador SQL
│   └── server.ts                   # Express + SSE /chat
├── public/index.html               # UI vanilla con streaming
├── package.json
├── tsconfig.json
└── .env.example
```

## Seguridad (defensa en profundidad)

La base **jamás** debe poder ser modificada por el LLM. Tres capas:

1. **Usuario Postgres read-only** — sólo `SELECT` sobre `mundial-fifa`.
2. **Validador SQL** (`src/db/client.ts`) — acepta solo `SELECT`/`WITH`, rechaza `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`, `COPY`, `SET`, `RESET`, etc., y multi-statement.
3. **Transacción `READ ONLY`** con `statement_timeout` — cualquier escape se bloquea a nivel transaccional.

Además se inyecta `LIMIT 100` si la query no lo trae.

## Fase 2 (TODO)

- Integrar [API-Football](https://www.api-football.com/) en `getLiveMatchData`.
- Persistir memoria con `@mastra/pg` (hoy es in-memory).
- Rate limiting en `/chat`.
- Logging estructurado de queries generadas (para auditoría y mejora del prompt).
