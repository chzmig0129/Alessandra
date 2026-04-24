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
-- Apply:
--   psql $SUPABASE_DB_URL -f migrations/sql/002_views.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. v_mundial_partidos
--    Denormalised match list with team names, confederation, ranking and venue.
--    fecha_hora_cdmx converts the UTC timestamp to America/Mexico_City.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_partidos AS
SELECT
    p.id,
    (p.fecha_utc AT TIME ZONE 'America/Mexico_City')::timestamptz  AS fecha_hora_cdmx,
    p.fase,
    p.grupo,
    -- Local / equipo A
    p.equipo_local_codigo                                           AS equipo_a_codigo,
    ea.nombre                                                       AS equipo_a_nombre,
    p.equipo_local_desc                                             AS equipo_a_desc,
    ea.confederacion                                                AS conf_a,
    ea.fifa_ranking                                                 AS rank_a,
    -- Visitante / equipo B
    p.equipo_visitante_codigo                                       AS equipo_b_codigo,
    eb.nombre                                                       AS equipo_b_nombre,
    p.equipo_visitante_desc                                         AS equipo_b_desc,
    eb.confederacion                                                AS conf_b,
    eb.fifa_ranking                                                 AS rank_b,
    -- Sede
    s.id                                                            AS sede_id,
    s.ciudad                                                        AS sede_ciudad,
    s.pais                                                          AS sede_pais,
    s.nombre                                                        AS sede_estadio,
    -- Estado y marcador
    p.estado,
    p.goles_local                                                   AS marcador_a,
    p.goles_visitante                                               AS marcador_b
FROM "mundial-fifa".partidos     AS p
LEFT JOIN "mundial-fifa".equipos AS ea ON ea.codigo = p.equipo_local_codigo
LEFT JOIN "mundial-fifa".equipos AS eb ON eb.codigo = p.equipo_visitante_codigo
LEFT JOIN "mundial-fifa".sedes   AS s  ON s.id = p.sede_id;

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
--    Venue catalogue with location; google_maps_url is a convenience column
--    present in the real table (seen in findSede.ts queries).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_sedes AS
SELECT
    id,
    nombre,
    ciudad,
    pais,
    direccion,
    capacidad,
    latitud,
    longitud,
    zona_horaria,
    descripcion,
    -- TODO: google_maps_url is present in the sedes table per findSede.ts but
    --       was not listed in queryDatabase.ts schema doc. Including it here;
    --       if column does not exist, remove this line and re-apply.
    google_maps_url
FROM "mundial-fifa".sedes;

-- ---------------------------------------------------------------------------
-- 4. v_mundial_fan_fest
--    Fan Festival locations (used by findFanFest tool).
--    NOTE: spec named this v_mundial_sedes in 4.4 but the table is fan_fest;
--          keeping original name pattern for clarity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_fan_fest AS
SELECT
    id,
    nombre,
    ciudad,
    pais,
    ubicacion,
    latitud,
    longitud,
    fecha_inicio,
    fecha_fin,
    horario,
    capacidad,
    entrada_gratis,
    descripcion,
    url_oficial,
    google_maps_url
FROM "mundial-fifa".fan_fest;

-- ---------------------------------------------------------------------------
-- 5. v_mundial_eventos_partido
--    Match events (goals, cards, substitutions…). No sensitive columns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_mundial_eventos_partido AS
SELECT
    id,
    partido_id,
    minuto,
    minuto_extra,
    tipo,
    equipo_codigo,
    jugador,
    jugador_asiste,
    detalle
FROM "mundial-fifa".eventos_partido;

-- ---------------------------------------------------------------------------
-- 6. v_puntos_violeta
--    Safe spaces for women in CDMX.
--    Excluded: interior_number (PII risk), responsible (internal routing),
--              facebook/instagram/twitter (social handles, not needed for
--              routing), geocode_precision (internal quality flag),
--              source_id (external import id), created_at/updated_at.
--    The column `tipo` is present per queryAlessandra.ts schema doc.
--    Spec requested: id, nombre→name, direccion(street+ext), colonia→neighborhood,
--    alcaldia(not a col; use bounding box externally), lat, lng, telefono→phone,
--    horario→hours, tipo_atencion(mapped to tipo), atencion_24_7(derived).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_puntos_violeta AS
SELECT
    id,
    name                                                            AS nombre,
    -- Build a single dirección string from street + exterior_number
    CASE
        WHEN exterior_number IS NOT NULL AND exterior_number NOT IN ('', 'N/A', 'n/a', 'NO TIENE')
             THEN trim(concat(street, ' ', exterior_number))
        ELSE street
    END                                                             AS direccion,
    street,
    exterior_number,
    neighborhood                                                    AS colonia,
    postal_code,
    lat,
    lng,
    phone                                                           AS telefono,
    hours                                                           AS horario,
    tipo                                                            AS tipo_atencion,
    -- atencion_24_7: derived from hours text; best-effort
    (
        lower(coalesce(hours, '')) LIKE '%24%'
        OR lower(coalesce(hours, '')) LIKE '%las 24%'
        OR lower(coalesce(hours, '')) LIKE '%24 horas%'
    )                                                               AS atencion_24_7,
    active
FROM public.puntos_violeta
WHERE active = true;

-- ---------------------------------------------------------------------------
-- 7. v_emergency_contacts
--    Emergency / crisis contacts (phone lines, services).
--    ASSUMPTION: table public.emergency_contacts has at minimum
--    id, nombre, telefono, descripcion, category, activo columns.
--    TODO: verify column names against actual table DDL; adjust if needed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_emergency_contacts AS
SELECT
    id,
    nombre,
    telefono,
    descripcion,
    category,
    activo
FROM public.emergency_contacts
WHERE activo = true;

-- ---------------------------------------------------------------------------
-- 8. v_security_facilities
--    Centros de salud, hospitales, instalaciones de seguridad públicas.
--    The table public.centros_salud is documented in queryAlessandra.ts and
--    covers hospitals and health centres in Alcaldía Cuauhtémoc.
--    Mapping: nombre→nombre, tipo→tipo, direccion→direccion, lat, lng,
--             telefono, horario.
--    NOTE: spec names the source table as "security_facilities" but the only
--          confirmed table with this profile is public.centros_salud.
--    TODO: if a separate public.security_facilities table exists, replace the
--          FROM clause. For now using centros_salud as best-effort source.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_security_facilities AS
SELECT
    id,
    nombre,
    tipo,
    direccion,
    lat,
    lng,
    telefono,
    horario
FROM public.centros_salud;

-- ---------------------------------------------------------------------------
-- 9. v_leads_publico
--    Public-safe view of citizen reports (leads/reportes).
--    NEVER expose: descripcion (may contain PII), datos del reportante
--    (nombre, email, telefono of the person who filed the report), any
--    internal routing or assignee information.
--    ASSUMPTION: table public.leads has at minimum
--    folio, categoria, tipo, status, created_at, colonia columns.
--    TODO: verify column names against actual table DDL; adjust if needed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_leads_publico AS
SELECT
    folio,
    categoria,
    tipo,
    status,
    created_at,
    colonia
FROM public.leads;

-- ---------------------------------------------------------------------------
-- 10. v_tramites
--    Trámites municipales: catalogue of administrative procedures.
--    ASSUMPTION: table public.tramites has at minimum
--    id, nombre, descripcion, requisitos, costo, area_responsable columns.
--    TODO: verify column names against actual table DDL; adjust if needed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tramites AS
SELECT
    id,
    nombre,
    descripcion,
    requisitos,
    costo,
    area_responsable
FROM public.tramites;

-- ---------------------------------------------------------------------------
-- 11. v_cartelera_events  /  v_cartelera_venues
--    Cultural events billboard for Alcaldía Cuauhtémoc.
--    The source tables (cartelera_events / cartelera_venues) are NOT present
--    in any existing tool code reviewed (mundial-bot/src/mastra/tools/*.ts,
--    mundial-bot/src/db/client.ts). Their existence in the DB is unconfirmed.
--    Per spec: if tables do not exist, leave a TODO --SKIP-- comment instead.
--    TODO --SKIP-- cartelera_events: table public.cartelera_events not confirmed;
--         create view once table DDL is available.
--    TODO --SKIP-- cartelera_venues: table public.cartelera_venues not confirmed;
--         create view once table DDL is available.
-- ---------------------------------------------------------------------------

/*
-- Uncomment and adjust column list once tables are confirmed to exist:

CREATE OR REPLACE VIEW v_cartelera_events AS
SELECT *
FROM public.cartelera_events;

CREATE OR REPLACE VIEW v_cartelera_venues AS
SELECT *
FROM public.cartelera_venues;
*/
