-- =============================================================================
-- Migration: 002_views.sql
-- Description: Curated v_* views that form the SURFACE AREA of the SQL sandbox
--              (sql_sandbox role / consulta_analitica_sql tool).
--
-- SECURITY NOTE: These views are the ONLY tables the sandbox role may SELECT.
--   Sensitive columns (notas_internas, internal metadata, PII beyond what is
--   explicitly listed, etc.) MUST NEVER appear here. GRANTs are in 004.
--
-- Idempotency: every statement uses CREATE OR REPLACE VIEW — safe to re-apply.
--
-- Schema audit reconciled: 2026-04-24. Column names verified against real
-- Supabase schema via MCP audit.
--
-- Apply:
--   psql $SUPABASE_DB_URL -f migrations/sql/002_views.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. v_mundial_partidos
--    Denormalised match list with team names, confederation, ranking and venue.
--    fecha_hora_cdmx converts the UTC timestamp to America/Mexico_City.
--    Schema "mundial-fifa" has a hyphen — must be double-quoted everywhere.
--    Real partidos cols used: numero_partido, fase, grupo, jornada, fecha_utc,
--    fecha_local, equipo_local_codigo, equipo_visitante_codigo,
--    equipo_local_desc, equipo_visitante_desc, sede_id, estado,
--    goles_local, goles_visitante, goles_local_penales, goles_visitante_penales.
--    Real sedes cols for location: latitud, longitud (aliased to sede_lat/lng).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_partidos AS
SELECT
    p.id,
    p.numero_partido,
    -- Returned as raw timestamptz; TS formats with Intl + timeZone: 'America/Mexico_City'.
    -- Earlier (AT TIME ZONE … ::timestamptz) double-cast corrupted the value.
    p.fecha_utc                                                          AS fecha_hora_cdmx,
    p.fase,
    p.grupo,
    p.jornada,
    -- Local / equipo A
    p.equipo_local_codigo                                                AS equipo_a_codigo,
    ea.nombre                                                            AS equipo_a_nombre,
    p.equipo_local_desc                                                  AS equipo_a_desc,
    ea.confederacion                                                     AS conf_a,
    ea.fifa_ranking                                                      AS rank_a,
    ea.bandera_url                                                       AS bandera_a,
    -- Visitante / equipo B
    p.equipo_visitante_codigo                                            AS equipo_b_codigo,
    eb.nombre                                                            AS equipo_b_nombre,
    p.equipo_visitante_desc                                              AS equipo_b_desc,
    eb.confederacion                                                     AS conf_b,
    eb.fifa_ranking                                                      AS rank_b,
    eb.bandera_url                                                       AS bandera_b,
    -- Sede
    p.sede_id,
    s.nombre                                                             AS sede_nombre,
    s.ciudad                                                             AS sede_ciudad,
    s.pais                                                               AS sede_pais,
    s.capacidad                                                          AS sede_capacidad,
    s.latitud                                                            AS sede_lat,
    s.longitud                                                           AS sede_lng,
    s.google_maps_url                                                    AS sede_google_maps_url,
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

-- ---------------------------------------------------------------------------
-- 2. v_mundial_equipos
--    Full team catalogue (no sensitive data; bandera_url is public asset).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_equipos AS
SELECT
    codigo,
    nombre,
    nombre_en,
    confederacion,
    grupo,
    bandera_url,
    bandera_emoji,
    fifa_ranking
FROM "mundial-fifa".equipos;

-- ---------------------------------------------------------------------------
-- 3. v_mundial_sedes
--    Venue catalogue with location.
--    latitud/longitud aliased to lat/lng for API consistency.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_sedes AS
SELECT
    id,
    nombre,
    ciudad,
    pais,
    capacidad,
    latitud                                                              AS lat,
    longitud                                                             AS lng,
    zona_horaria,
    descripcion,
    direccion,
    google_maps_url
FROM "mundial-fifa".sedes;

-- ---------------------------------------------------------------------------
-- 4. v_mundial_fan_fest
--    Fan Festival locations (used by findFanFest tool).
--    latitud/longitud aliased to lat/lng for consistency.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_fan_fest AS
SELECT *
FROM "mundial-fifa".fan_fest;

-- ---------------------------------------------------------------------------
-- 5. v_mundial_eventos_partido
--    Match events (goals, cards, substitutions…). No sensitive columns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_eventos_partido AS
SELECT *
FROM "mundial-fifa".eventos_partido;

-- ---------------------------------------------------------------------------
-- 6. v_mundial_alineaciones
--    Squad lineups per match.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_alineaciones AS
SELECT *
FROM "mundial-fifa".alineaciones;

-- ---------------------------------------------------------------------------
-- 7. v_puntos_violeta
--    Safe spaces for women in CDMX (Alcaldía Cuauhtémoc).
--    Real cols: name, hours, street, exterior_number, neighborhood,
--               phone, lat, lng, tipo, active, geocode_precision.
--    alcaldia is a literal constant — not a column on the table.
--    atencion_24_7 derived from hours text.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_puntos_violeta AS
SELECT
    id,
    name                                                                 AS nombre,
    concat_ws(' ', street, exterior_number)                             AS direccion,
    neighborhood                                                         AS colonia,
    'Cuauhtémoc'::text                                                   AS alcaldia,
    lat,
    lng,
    phone                                                                AS telefono,
    hours                                                                AS horario,
    tipo                                                                 AS tipo_atencion,
    (
        hours ILIKE '%24%'
        OR hours ILIKE '%horas%'
    )                                                                    AS atencion_24_7,
    geocode_precision
FROM public.puntos_violeta
WHERE active = true;

-- ---------------------------------------------------------------------------
-- 8. v_emergency_contacts
--    Emergency / crisis contacts.
--    Real cols: number, name, available_24_7, active (plus description,
--               category, coverage_area, whatsapp, priority).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_emergency_contacts AS
SELECT
    id,
    name                                                                 AS nombre,
    number                                                               AS telefono,
    description                                                          AS descripcion,
    category,
    available_24_7,
    coverage_area,
    whatsapp,
    priority
FROM public.emergency_contacts
WHERE active = true;

-- ---------------------------------------------------------------------------
-- 9. v_security_facilities
--    Security and public-safety facilities.
--    Real cols: facility_type, opens_24_7 (aliased as tipo, atencion_24_7).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_security_facilities AS
SELECT
    id,
    name                                                                 AS nombre,
    facility_type                                                        AS tipo,
    subtype,
    address                                                              AS direccion,
    colonia,
    lat,
    lng,
    phone                                                                AS telefono,
    opening_hours                                                        AS horario,
    opens_24_7                                                           AS atencion_24_7,
    jurisdiction_sector
FROM public.security_facilities
WHERE active = true;

-- ---------------------------------------------------------------------------
-- 10. v_leads_publico
--    Public-safe view of citizen reports.
--    NEVER expose: report (may contain PII), datos del reportante,
--    internal routing or assignee information.
--    Real cols: folio, category (not categoria), report_type (not tipo),
--               status (lead_status enum), created_at, location_address.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_leads_publico AS
SELECT
    folio,
    category                                                             AS categoria,
    report_type                                                          AS tipo,
    status::text,
    created_at,
    location_address                                                     AS colonia
FROM public.leads
WHERE folio IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 11. v_tramites
--    Trámites municipales: catalogue of administrative procedures.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tramites AS
SELECT
    id,
    name                                                                 AS nombre,
    description                                                          AS descripcion,
    requirements                                                         AS requisitos,
    area,
    business_hours,
    contact,
    dependency,
    presentation
FROM public.tramites
WHERE active = true;

-- ---------------------------------------------------------------------------
-- 12. v_cartelera_events
--    Cultural events billboard for Alcaldía Cuauhtémoc.
--    Table public.cartelera_events confirmed existing per schema audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cartelera_events AS
SELECT *
FROM public.cartelera_events;

-- ---------------------------------------------------------------------------
-- 13. v_cartelera_venues
--    Venues for cultural events.
--    Table public.cartelera_venues confirmed existing per schema audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cartelera_venues AS
SELECT *
FROM public.cartelera_venues;

-- ---------------------------------------------------------------------------
-- 14. v_report_taxonomy
--    Report classification taxonomy used by crear_lead and AI analysis.
--    Cols: slug, parent_slug, kind, name, attributes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_report_taxonomy AS
SELECT
    slug,
    parent_slug,
    kind,
    name,
    attributes
FROM public.report_taxonomy
WHERE active = true;

-- ---------------------------------------------------------------------------
-- 15. Security hardening: force SECURITY INVOKER on all v_* views so they
--     respect the calling role's RLS instead of running as the view owner.
--     Without this, Postgres defaults to SECURITY DEFINER, which bypasses
--     RLS for any caller (including anon via PostgREST). Service-role
--     callers bypass RLS anyway; sandbox role only sees rows it has direct
--     SELECT on the underlying tables for (none, by design — sandbox is
--     restricted via 004 GRANTs to the views themselves).
-- ---------------------------------------------------------------------------
ALTER VIEW v_mundial_partidos        SET (security_invoker = true);
ALTER VIEW v_mundial_equipos         SET (security_invoker = true);
ALTER VIEW v_mundial_sedes           SET (security_invoker = true);
ALTER VIEW v_mundial_fan_fest        SET (security_invoker = true);
ALTER VIEW v_mundial_eventos_partido SET (security_invoker = true);
ALTER VIEW v_mundial_alineaciones    SET (security_invoker = true);
ALTER VIEW v_puntos_violeta          SET (security_invoker = true);
ALTER VIEW v_emergency_contacts      SET (security_invoker = true);
ALTER VIEW v_security_facilities     SET (security_invoker = true);
ALTER VIEW v_leads_publico           SET (security_invoker = true);
ALTER VIEW v_tramites                SET (security_invoker = true);
ALTER VIEW v_cartelera_events        SET (security_invoker = true);
ALTER VIEW v_cartelera_venues        SET (security_invoker = true);
ALTER VIEW v_report_taxonomy         SET (security_invoker = true);
