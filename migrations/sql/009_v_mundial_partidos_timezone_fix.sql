-- =============================================================================
-- Migration: 009_v_mundial_partidos_timezone_fix.sql
-- Description: Fix misnamed alias bug in v_mundial_partidos.
--
-- BUG (discovered via voice agent test, 2026-04-25):
--   The view had `p.fecha_utc AS fecha_hora_cdmx` — an alias that returned a raw
--   UTC timestamptz under a column name that implied CDMX local time.  The LLM
--   (and the voice agent) trusted the column name and reported kick-off times
--   incorrectly (e.g. "7 PM" when the actual CDMX local time was "1 PM").
--
-- FIX — two changes to the SELECT list:
--   1. ADD new column `fecha_utc` → p.fecha_utc (timestamptz, honest raw UTC)
--   2. FIX existing column `fecha_hora_cdmx` → p.fecha_utc AT TIME ZONE
--      'America/Mexico_City'  (now a true timestamp without time zone in
--      CDMX local wall-clock time, not the misleading UTC value)
--
-- Both columns coexist so callers can choose the appropriate one:
--   • fecha_utc       — for UTC-to-UTC comparisons, ordering, ISO serialization
--   • fecha_hora_cdmx — for user-facing display and CDMX date-range filters
--
-- Idempotency: CREATE OR REPLACE VIEW — safe to re-apply.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_mundial_partidos AS
SELECT
    p.id,
    p.numero_partido,
    -- Raw UTC timestamp (timestamptz). Use this for ordering and UTC comparisons.
    p.fecha_utc                                                               AS fecha_utc,
    -- CDMX local wall-clock time (timestamp without time zone).
    -- Computed via AT TIME ZONE so the stored UTC value is converted correctly.
    p.fecha_utc AT TIME ZONE 'America/Mexico_City'                            AS fecha_hora_cdmx,
    p.fase,
    p.grupo,
    p.jornada,
    -- Local / equipo A
    p.equipo_local_codigo                                                     AS equipo_a_codigo,
    ea.nombre                                                                 AS equipo_a_nombre,
    p.equipo_local_desc                                                       AS equipo_a_desc,
    ea.confederacion                                                          AS conf_a,
    ea.fifa_ranking                                                           AS rank_a,
    ea.bandera_url                                                            AS bandera_a,
    -- Visitante / equipo B
    p.equipo_visitante_codigo                                                 AS equipo_b_codigo,
    eb.nombre                                                                 AS equipo_b_nombre,
    p.equipo_visitante_desc                                                   AS equipo_b_desc,
    eb.confederacion                                                          AS conf_b,
    eb.fifa_ranking                                                           AS rank_b,
    eb.bandera_url                                                            AS bandera_b,
    -- Sede
    p.sede_id,
    s.nombre                                                                  AS sede_nombre,
    s.ciudad                                                                  AS sede_ciudad,
    s.pais                                                                    AS sede_pais,
    s.capacidad                                                               AS sede_capacidad,
    s.latitud                                                                 AS sede_lat,
    s.longitud                                                                AS sede_lng,
    s.google_maps_url                                                         AS sede_google_maps_url,
    -- Estado y marcador
    p.estado,
    p.goles_local,
    p.goles_visitante,
    p.goles_local_penales,
    p.goles_visitante_penales
FROM "mundial-fifa".partidos      AS p
LEFT JOIN "mundial-fifa".equipos  AS ea ON ea.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos  AS eb ON eb.codigo = p.equipo_visitante_codigo
LEFT JOIN "mundial-fifa".sedes    AS s  ON s.id = p.sede_id;
