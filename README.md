# Alessandra — Asistente Ciudadano · Alcaldía Cuauhtémoc

## Qué es

Alessandra es un asistente conversacional ciudadano para la Alcaldía Cuauhtémoc. Cubre tres dominios iniciales: Mundial FIFA 2026, Puntos Violeta y Reportes Ciudadanos, con arquitectura plugin-based para agregar nuevos dominios.

## Stack

- **Next.js 15** (App Router) + **TypeScript** strict
- **Mastra SDK** para orquestación de agentes
- **AI SDK** (OpenAI / Gemini) para modelos
- **Supabase** (Postgres + Auth + Storage)
- **Tailwind CSS 3** para UI
- **Vitest** para tests y eval set

## Setup local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env.local
# Editar .env.local con tus keys reales

# 3. Aplicar migraciones (requiere psql y SUPABASE_DB_URL)
# psql $SUPABASE_DB_URL -f migrations/sql/001_session_support.sql
# psql $SUPABASE_DB_URL -f migrations/sql/002_views.sql
# psql $SUPABASE_DB_URL -f migrations/sql/003_crear_lead_function.sql
# psql $SUPABASE_DB_URL -f migrations/sql/004_readonly_role.sql
```

## Cómo correr

```bash
npm run dev        # Servidor de desarrollo en http://localhost:3000
npm run build      # Build de producción
npm run typecheck  # Verificar tipos sin compilar
npm run lint       # Linter ESLint
npm test           # Tests unitarios con Vitest
```

## Cómo agregar un dominio

> Documentación detallada pendiente (issue final).

## Eval

```bash
npm run eval  # Corre tests/eval/runner.ts contra el modelo configurado
```

## Deploy

> Guía de deploy en Vercel pendiente (issue final).
