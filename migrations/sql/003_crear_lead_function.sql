-- Migration: 003_crear_lead_function
-- Description: Creates (or replaces) the PL/pgSQL function crear_lead() that
--              atomically increments a per-day folio counter and inserts a new
--              lead row, returning the generated folio and the new lead's UUID.
--
-- Schema audit reconciled: 2026-04-24.
--   lead_folio_counters: PK fecha (date), col last_seq (int).
--   leads real cols used: id, conversation_id, user_id, category, report_type,
--     report, lat, lng, location_address, media_urls, priority, severity, tags,
--     incident_subtype, ai_analysis, status (lead_status enum), folio.
--
-- Apply:
--   psql $SUPABASE_DB_URL -f migrations/sql/003_crear_lead_function.sql
--
-- This migration is idempotent: safe to run multiple times without side effects
-- (uses CREATE OR REPLACE FUNCTION).

-- ---------------------------------------------------------------------------
-- 1. crear_lead function
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crear_lead(
  p_conversation_id  uuid,
  p_user_id          uuid,
  p_category         text,
  p_report_type      text,
  p_report           text,
  p_lat              double precision,
  p_lng              double precision,
  p_location_address text,
  p_media_urls       text[],
  p_priority         smallint  DEFAULT 2,
  p_severity         text      DEFAULT NULL,
  p_tags             text[]    DEFAULT NULL,
  p_incident_subtype text      DEFAULT NULL,
  p_ai_analysis      jsonb     DEFAULT NULL
)
RETURNS TABLE(folio text, lead_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'America/Mexico_City')::date;
  v_counter int;
  v_folio   text;
  v_lead_id uuid;
BEGIN
  -- Atomically upsert+increment the daily folio counter.
  -- PK is `fecha` (date); counter column is `last_seq` (int).
  -- The single INSERT … ON CONFLICT … RETURNING eliminates any race window:
  -- the counter value we read is the one we own.
  INSERT INTO lead_folio_counters (fecha, last_seq)
    VALUES (v_today, 1)
    ON CONFLICT (fecha)
    DO UPDATE SET last_seq = lead_folio_counters.last_seq + 1
    RETURNING last_seq INTO v_counter;

  -- Build folio: CUH-YYYYMMDD-NNN (zero-padded to 3 digits, e.g. CUH-20260424-001)
  v_folio := 'CUH-' || to_char(v_today, 'YYYYMMDD') || '-' || lpad(v_counter::text, 3, '0');

  -- Insert the lead and capture its generated UUID.
  -- status defaults to 'pending_review'::lead_status per enum definition.
  INSERT INTO leads (
    folio,
    conversation_id,
    user_id,
    category,
    report_type,
    report,
    lat,
    lng,
    location_address,
    media_urls,
    priority,
    severity,
    tags,
    incident_subtype,
    ai_analysis,
    status
  ) VALUES (
    v_folio,
    p_conversation_id,
    p_user_id,
    p_category,
    p_report_type,
    p_report,
    p_lat,
    p_lng,
    p_location_address,
    p_media_urls,
    p_priority,
    p_severity,
    p_tags,
    p_incident_subtype,
    p_ai_analysis,
    'pending_review'::lead_status
  )
  RETURNING id INTO v_lead_id;

  RETURN QUERY SELECT v_folio, v_lead_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Grant execute to Supabase roles
-- ---------------------------------------------------------------------------

GRANT EXECUTE
  ON FUNCTION crear_lead(
    uuid, uuid, text, text, text,
    double precision, double precision, text, text[],
    smallint, text, text[], text, jsonb
  )
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Pin search_path to prevent SQL-injection-via-search-path attacks.
--    With a mutable search_path, an attacker who controls a schema in front
--    of public on the role's search_path could shadow built-ins / our tables.
-- ---------------------------------------------------------------------------
ALTER FUNCTION crear_lead(
  uuid, uuid, text, text, text,
  double precision, double precision, text, text[],
  smallint, text, text[], text, jsonb
) SET search_path = public, pg_temp;
