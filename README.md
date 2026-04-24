# Alessandra — Asistente Ciudadano · Alcaldía Cuauhtémoc

## 1. Qué es Alessandra

Alessandra es un asistente conversacional ciudadano desarrollado para la Alcaldía Cuauhtémoc. Su misión es acercar servicios y
información municipal al ciudadano a través de una interfaz de lenguaje natural, reduciendo la fricción de trámites y
consultas que hoy requieren llamadas telefónicas, presencia física o navegación por portales institucionales complejos.

El sistema está construido con una arquitectura **plugin-based** (dominios desacoplados): cada área temática expone un conjunto
de herramientas (tools) que el orquestador central utiliza según el intent detectado. Agregar un nuevo dominio no requiere
modificar el núcleo de la conversación — solo crear los archivos del dominio y registrar sus tools.

Los tres dominios iniciales cubren: **Mundial FIFA 2026** (partidos, sedes, Fan Fest en CDMX), **Puntos Violeta** (red de
atención a mujeres en situación de violencia, geolocalizada, con canal de emergencia de respuesta inmediata) y **Reportes
Ciudadanos** (flujo guiado de captura y seguimiento de reportes de infraestructura urbana: baches, alumbrado, fugas, árboles
caídos, etc.).

---

## 2. Stack

| Capa | Tecnología | Notas |
|---|---|---|
| Framework web | Next.js 15 (App Router) | Runtime Node en todas las rutas API |
| Lenguaje | TypeScript 5 — modo estricto | `tsc --noEmit` obligatorio en CI |
| Orquestacion de agente | Mastra SDK `@mastra/core` | Agente singleton con `Agent.generate()` |
| LLM — chat principal | OpenAI `gpt-4o-mini` (configurable via `MODEL_CHAT`) | |
| LLM — eval judge | OpenAI `gpt-4o` (configurable via `MODEL_EVAL`) | |
| LLM — SQL / vision | Google Gemini 2.0 Flash (configurable via `MODEL_SQL`, `MODEL_VISION`) | |
| Base de datos | Supabase (Postgres 15 + Auth + Storage) | Pool via `postgres` npm |
| Estilos | Tailwind CSS 3 | Acento `#8B5CF6` violeta |
| Tests unitarios | Vitest 3 | `npm test` |
| Eval set | Runner propio (`tsx`) | `npm run eval` |

---

## 3. Setup local

### Requisitos previos

- Node.js 20+ y npm 10+
- Acceso a un proyecto Supabase (free tier es suficiente)
- Claves de API: OpenAI y Google AI Studio
- `psql` instalado localmente (para aplicar migraciones)

### Pasos

```bash
# 1. Clonar el repositorio
git clone <url-del-repo> agente-alessandra
cd agente-alessandra

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env.local
# Editar .env.local — ver tabla de variables abajo

# 4. Aplicar las 4 migraciones SQL (ver sección 4)
psql "$SUPABASE_DB_URL" -f migrations/sql/001_session_support.sql
psql "$SUPABASE_DB_URL" -f migrations/sql/002_views.sql
psql "$SUPABASE_DB_URL" -f migrations/sql/003_crear_lead_function.sql
psql "$SUPABASE_DB_URL" -f migrations/sql/004_readonly_role.sql

# 5. Levantar servidor de desarrollo
npm run dev
# http://localhost:3000/chat
```

### Variables de entorno requeridas

| Variable | Obligatoria | Descripcion | Donde obtener |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Si | URL del proyecto Supabase | Dashboard > Settings > API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Si | Clave anon publica | Dashboard > Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Si | Clave service role (nunca exponer al cliente) | Dashboard > Settings > API |
| `OPENAI_API_KEY` | Si | Clave API de OpenAI | platform.openai.com/api-keys |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Si | Clave API de Google AI | aistudio.google.com/apikey |
| `SUPABASE_SANDBOX_DB_URL` | No | URL de conexion para el rol sql_sandbox (texto a SQL) | Ver seccion 4, paso final |

### Variables opcionales con valores por defecto

| Variable | Default | Descripcion |
|---|---|---|
| `MODEL_CHAT` | `gpt-4o-mini` | Modelo principal de conversacion |
| `MODEL_EVAL` | `gpt-4o` | Modelo para LLM-judge en evals |
| `MODEL_SQL` | `gemini-2.0-flash` | Modelo para generacion de SQL |
| `MODEL_VISION` | `gemini-2.0-flash` | Modelo para analisis de imagenes |
| `MODEL_EMBEDDINGS` | `text-embedding-3-small` | Modelo de embeddings |
| `SESSION_TTL_HOURS` | `6` | Tiempo de vida de sesion activa |
| `FLOW_TTL_MINUTES` | `30` | Tiempo de vida de un flujo de reporte |
| `MAX_CONTEXT_MESSAGES` | `20` | Mensajes recientes que se pasan al modelo |

---

## 4. Aplicar migraciones

Las migraciones se aplican en orden estricto. Obtener la `SUPABASE_DB_URL` directa desde:
Dashboard > Settings > Database > Connection string (modo "URI", con password).

```bash
export SUPABASE_DB_URL="postgresql://postgres:<password>@<host>:5432/<db>"

# 001 — Columnas de sesion y tabla unanswered_questions (idempotente)
psql "$SUPABASE_DB_URL" -f migrations/sql/001_session_support.sql

# 002 — Vistas publicas v_* para dominios (idempotente)
psql "$SUPABASE_DB_URL" -f migrations/sql/002_views.sql

# 003 — Funcion helper create_lead (idempotente)
psql "$SUPABASE_DB_URL" -f migrations/sql/003_crear_lead_function.sql

# 004 — Rol sql_sandbox read-only (idempotente, REQUIERE superuser)
psql "$SUPABASE_DB_URL" -f migrations/sql/004_readonly_role.sql
```

**Nota sobre 004:** La migracion 004 crea el rol `sql_sandbox` con `NOLOGIN`. Requiere que el usuario de conexion tenga
privilegios de superuser (el usuario `postgres` de Supabase Direct Connection los tiene). Si falla con "permission denied
to create role", asegurate de usar la cadena de conexion directa (puerto 5432), no el pooler (puerto 6543).

### Crear el usuario de sandbox (despues de 004)

```sql
-- Ejecutar en el SQL Editor de Supabase o via psql como superuser:
CREATE USER sandbox_user WITH LOGIN PASSWORD '<contrasena-fuerte-aleatoria>';
GRANT sql_sandbox TO sandbox_user;
```

Luego agregar a `.env.local`:

```bash
SUPABASE_SANDBOX_DB_URL=postgresql://sandbox_user:<contrasena>@<host>:5432/<db>
```

---

## 5. Arquitectura

```
Usuario (browser /chat)
        |
        | POST /api/chat  {message, attachments, sessionId}
        v
+-----------------------------------------------------------------------+
|  1. AUTH / RATE LIMIT                                                 |
|     checkRateLimit(userId)  →  429 si excede umbral                   |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  2. SESSION                                                           |
|     getOrCreateActiveSession(userId)                                  |
|     → conversationId  (TTL 6h, renovado en cada turno)               |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  3. PRE-LLM GUARDRAILS                                                |
|     detectGenderEmergency()  →  short-circuit si true                 |
|       └─ emergencia_mujer_canalizar() + genderEmergencyResponse()     |
|     detectJailbreak()        →  respuesta fija si true                |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  4. ORCHESTRATOR                                                      |
|     classifyDomain(message, flowSnapshot)                             |
|       └─ scoreDomain() heuristica regex (0.3/match, umbral 0.4)      |
|       └─ stickiness boost 0.85 si hay flow activo no expirado        |
|     buildSystemPrompt = SYSTEM_PROMPT_BASE + promptForDomain()        |
|     Agent.generate(messages, { maxSteps:5, temperature:0|0.3 })      |
|       └─ ALL_TOOLS: 5 mundial + 3 violeta + 7 reportes + 1 sql       |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  5. POST-LLM                                                          |
|     citationCheck(rawText, toolResults)                               |
|       → si falla: 1 retry con REWRITE INSTRUCTION                    |
|       → si reintento falla: respuesta de error estandar              |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  6. PERSISTENCIA                                                      |
|     appendMessage(conversationId, user)                               |
|     appendMessage(conversationId, assistant + tool_calls + tokens)    |
|     bumpSessionTtl(conversationId)                                    |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  7. RESPUESTA                                                         |
|     { text, debug: { tool_calls, tokens, latency_ms, classification }}|
+-----------------------------------------------------------------------+
        |
        v
Usuario (burbuja en /chat, toggle "Ver razonamiento" muestra debug)
```

---

## 6. Agregar un dominio nuevo (ejemplo: `restaurantes`)

### Paso 1 — Crear los archivos del dominio

```bash
mkdir -p src/domains/restaurantes
```

**`src/domains/restaurantes/queries.ts`** — consultas SQL via Supabase:

```ts
import { supabaseAdmin } from "@/db/client";

export interface Restaurante {
  id: string;
  nombre: string;
  colonia: string;
  lat: number;
  lng: number;
  cocina: string;
  calificacion: number;
}

export async function buscarRestaurantes(params: {
  colonia?: string;
  cocina?: string;
  lat?: number;
  lng?: number;
  limite?: number;
}): Promise<Restaurante[]> {
  let query = supabaseAdmin
    .from("v_restaurantes")
    .select("*")
    .limit(params.limite ?? 5);

  if (params.colonia) query = query.ilike("colonia", `%${params.colonia}%`);
  if (params.cocina) query = query.eq("cocina", params.cocina);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Restaurante[];
}
```

**`src/domains/restaurantes/tools.ts`** — tools expuestos al agente:

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buscarRestaurantes } from "./queries";

export const restaurantesBuscar = createTool({
  id: "restaurantes_buscar",
  description: "Busca restaurantes en la Alcaldía Cuauhtémoc por colonia o tipo de cocina.",
  inputSchema: z.object({
    colonia: z.string().optional().describe("Colonia o zona"),
    cocina: z.string().optional().describe("Tipo de cocina, p. ej. 'mexicana'"),
    lat: z.number().optional(),
    lng: z.number().optional(),
  }),
  execute: async ({ context }) => {
    return buscarRestaurantes(context);
  },
});
```

### Paso 2 — Agregar la vista en una nueva migracion

Crear `migrations/sql/005_vista_restaurantes.sql`:

```sql
-- Migration: 005_vista_restaurantes
-- Description: Vista publica para el dominio restaurantes.
-- Apply: psql $SUPABASE_DB_URL -f migrations/sql/005_vista_restaurantes.sql

CREATE OR REPLACE VIEW v_restaurantes AS
SELECT
  id,
  nombre,
  colonia,
  ST_Y(geom::geometry) AS lat,
  ST_X(geom::geometry) AS lng,
  tipo_cocina AS cocina,
  calificacion
FROM restaurantes
WHERE activo = true;

-- Conceder acceso al rol sandbox
GRANT SELECT ON v_restaurantes TO sql_sandbox;
```

Aplicar:

```bash
psql "$SUPABASE_DB_URL" -f migrations/sql/005_vista_restaurantes.sql
```

### Paso 3 — Registrar las tools en el orquestador

En `src/agent/orchestrator.ts`, importar y agregar al record `ALL_TOOLS`:

```ts
import { restaurantesBuscar } from "@/domains/restaurantes/tools";

const ALL_TOOLS = {
  // ...tools existentes...
  restaurantes_buscar: restaurantesBuscar,
} as const;
```

### Paso 4 — Agregar el prompt del dominio

En `src/agent/prompts/domain-specific.ts`, agregar el case al switch:

```ts
case "restaurantes":
  return `
CONTEXTO RESTAURANTES:
- Busca siempre por colonia o zona cuando el usuario no da coordenadas.
- Nunca inventes calificaciones ni horarios. Si el dato no esta en los resultados, dilo.
- Presenta maximo 5 resultados en lista con nombre, colonia y tipo de cocina.`;
```

Tambien actualizar el tipo `Domain` en `src/types.ts` para incluir `"restaurantes"`.

### Paso 5 — Agregar la keyword al router heuristico

En `src/guardrails/router-confidence.ts`, actualizar `DOMAIN_PATTERNS`:

```ts
const DOMAIN_PATTERNS: Record<...> = {
  // ...dominios existentes...
  restaurantes: /restaurante|comer|comida|fonda|taqueria|menu|cenar/i,
};
```

Y agregar `"restaurantes"` al array `scoredDomains` dentro de `scoreDomain()`.

### Paso 6 — Crear casos de eval

Crear `tests/eval/cases/restaurantes.json`:

```json
[
  {
    "id": "rest-001",
    "description": "Busqueda por colonia",
    "turns": [
      { "user": "¿Que restaurantes hay en la Roma Norte?" }
    ],
    "expect": {
      "tool_called": "restaurantes_buscar",
      "input_contains": { "colonia": "Roma Norte" },
      "response_must_contain": ["Roma Norte"],
      "response_must_not_contain": ["no tengo informacion"]
    }
  }
]
```

Con estos 6 pasos el nuevo dominio queda completamente integrado.

---

## 7. Agregar un tool nuevo a un dominio existente

El proceso es mas corto porque el dominio ya existe:

1. **Agregar la funcion en `queries.ts`** del dominio — la logica de consulta a Supabase o a una API externa.

2. **Crear el tool en `tools.ts`** del mismo dominio usando `createTool`:

```ts
export const mundialArbitroInfo = createTool({
  id: "mundial_arbitro_info",
  description: "Devuelve informacion sobre el arbitro de un partido.",
  inputSchema: z.object({ partido_id: z.string() }),
  execute: async ({ context }) => {
    return getArbitroByPartido(context.partido_id);
  },
});
```

3. **Re-exportar si el dominio usa un barrel** (algunos dominios exportan todos sus tools desde un `index.ts`; si ya lo hacen, el paso siguiente es automatico).

4. **Importar y agregar en `src/agent/orchestrator.ts`** dentro del record `ALL_TOOLS`:

```ts
import { mundialArbitroInfo } from "@/domains/mundial/tools";

const ALL_TOOLS = {
  // ...tools existentes...
  mundial_arbitro_info: mundialArbitroInfo,
} as const;
```

5. **Agregar un caso de eval** en `tests/eval/cases/mundial.json` que valide `tool_called: "mundial_arbitro_info"`.

No es necesario modificar el prompt de dominio a menos que el tool tenga restricciones especiales de uso.

---

## 8. Correr evals

```bash
npm run eval
```

El runner carga todos los archivos `*.json` de `tests/eval/cases/`, ejecuta cada caso contra `processTurn()` con una
sesion sintetica (UUID aleatorio por caso) y reporta resultados por dominio.

### Salida de ejemplo

```
[eval] Loading cases from tests/eval/cases/...
[eval] Cases loaded: 65 (5 files)

Domain: mundial         pass 18/20  (90.0%)  judge_avg: 4.3
Domain: violeta         pass 15/15  (100.0%) judge_avg: 4.7
Domain: reportes        pass 20/20  (100.0%) judge_avg: 4.5
Domain: adversarial     pass 8/8    (100.0%) judge_avg: —
Domain: out-of-scope    pass 2/2    (100.0%) judge_avg: —

GLOBAL: deterministicPct=96.9%  judgeAvg=4.5
[eval] PASS (thresholds: det>=95%, judge>=4.0)
```

### Interpretar resultados

| Indicador | Umbral minimo | Significado si falla |
|---|---|---|
| `deterministicPct` | 95% | Un tool no se llama, o la respuesta contiene texto prohibido |
| `judgeAvg` | 4.0 / 5 | La respuesta es factualmente incorrecta, irrelevante o de tono inadecuado |

Los casos que usan `judge_rubric` pasan por `tests/eval/judge.ts`, que llama al modelo `MODEL_EVAL` con un prompt
estructurado y devuelve `{ factualidad, relevancia, tono }` en escala 0-5. El promedio de los tres subpuntajes se compara
con 4.0.

El proceso termina con exit code `0` si ambos umbrales se cumplen, o `1` si alguno falla. Util para bloquear un PR en CI.

---

## 9. Deploy en Vercel

### Comando

```bash
vercel --prod
```

### Variables de entorno requeridas en Vercel

Configurar en Dashboard > Project > Settings > Environment Variables:

| Variable | Notas |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Publica — visible en el cliente |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publica — visible en el cliente |
| `SUPABASE_SERVICE_ROLE_KEY` | Secreta — solo servidor |
| `OPENAI_API_KEY` | Secreta |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Secreta |
| `SUPABASE_SANDBOX_DB_URL` | Secreta — conexion como `sandbox_user` que hereda `sql_sandbox` |
| `MODEL_CHAT`, `MODEL_SQL`, etc. | Opcionales; usar defaults si no se especifican |

### Runtime Edge vs Node

Todas las rutas API de este proyecto usan el runtime de **Node.js** (no Edge). Esto es intencional:

- `/api/chat` — usa `processTurn` que conecta a Postgres via `postgres` npm (no compatible con Edge)
- `/api/upload` — usa Supabase Storage SDK y crea el bucket on-demand si no existe
- `/api/health` — verifica conectividad a Supabase

Si en el futuro se migra alguna ruta a Edge, se debera reemplazar el cliente Postgres por el cliente HTTP de Supabase.

### Nota sobre SUPABASE_SANDBOX_DB_URL

Esta variable apunta a un usuario Postgres con LOGIN que hereda el rol `sql_sandbox` (creado por la migracion 004).
El usuario debe existir en la base de datos antes del primer request que use `consulta_analitica_sql`. Vercel no crea
este usuario — se crea manualmente una vez (ver seccion 4).

---

## 10. Troubleshooting

| Sintoma | Causa probable | Solucion |
|---|---|---|
| `tsc error: cannot find module '@/...'` | Path alias `@/` no resuelto | Verificar `tsconfig.json`: debe tener `"paths": { "@/*": ["./src/*"] }` y `"baseUrl": "."` |
| `rate limit on Nominatim` o geocoding lento | API publica de Nominatim tiene limite por IP | Implementar cache de 30 dias en tabla `geocode_cache`; ya esta contemplado en la arquitectura pero requiere migracion |
| `Supabase Storage bucket not found` | El bucket no se creo aun | `/api/upload` lo crea on-demand en el primer request. Si el error persiste, verificar que `SUPABASE_SERVICE_ROLE_KEY` sea correcta y tenga permisos de Storage Admin |
| `tool not called` en evals o en produccion | Keyword del mensaje no activa el dominio correcto | Revisar regex en `DOMAIN_PATTERNS` en `src/guardrails/router-confidence.ts`; agregar sinonimos al patron del dominio afectado |
| `permission denied to create role` al aplicar 004 | Conexion via pooler (puerto 6543) sin permisos de superuser | Usar cadena de conexion directa (puerto 5432) con usuario `postgres` |
| `Cannot find module 'tsx'` al correr `npm run eval` | `tsx` no esta en devDependencies | `npm install` nuevamente; `tsx` esta en devDependencies del `package.json` |
| Respuesta del agente dice "no pude generar una respuesta verificable" | Citation check fallo dos veces | El tool devolvio datos vacios o el modelo los ignoro; revisar que la query SQL/Supabase devuelva registros y que el prompt del dominio mencione explicitamente usar los resultados |

---

## 11. Roadmap Fase 2

| Funcionalidad | Descripcion | Dependencias tecnicas |
|---|---|---|
| **WhatsApp / Twilio inbound** | Webhook Twilio → `processTurn` → respuesta por WhatsApp. Mismo orquestador, canal diferente. | Cuenta Twilio, numero WhatsApp Business, endpoint publico |
| **Dashboard admin** | Panel Next.js con metricas de uso, preguntas sin respuesta (`unanswered_questions`), tasa de exito por dominio | Supabase Auth (roles admin), graficas (recharts o similar) |
| **Dominio: Restaurantes** | Directorio de restaurantes en la alcaldia con busqueda por colonia y tipo de cocina | Datos abiertos CDMX, migracion 005+ |
| **Dominio: Hoteles** | Oferta de hospedaje cercana a sedes del Mundial FIFA 2026 | Datos SECTUR / datos abiertos |
| **Dominio: Cartelera** | Eventos culturales, teatro, musica en Cuauhtemoc | API de Secretaria de Cultura o scraping autorizado |
| **Dominio: Tramites** | Guia paso a paso para tramites de la alcaldia (licencias, actas, etc.) | Base de conocimiento estructurada por area de gobierno |
| **Dominio: Transporte** | Rutas CDMX, Metro, Metrob'us y bicicletas en tiempo real | API SEMOVI / GTFS-RT |
