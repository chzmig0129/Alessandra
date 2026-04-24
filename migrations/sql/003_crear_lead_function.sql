-- Migration: 003_crear_lead_function
-- Description: Creates (or replaces) the PL/pgSQL function crear_lead() that
--              atomically increments a per-day folio counter and inserts a new
--              lead row, returning the generated folio and the new lead's UUID.
--
-- Apply:
--   psql $SUPABASE_DB_URL -f migrations/sql/003_crear_lead_function.sql
--
-- This migration is idempotent: safe to run multiple times without side effects
-- (uses CREATE OR REPLACE FUNCTION).
--
-- ---------------------------------------------------------------------------
-- TODO (DBA — VERIFY BEFORE APPLYING TO PRODUCTION)
-- ---------------------------------------------------------------------------
-- The column names used below are derived from the spec and have NOT been
-- verified against the actual Supabase schema for the `leads` and
-- `lead_folio_counters` tables.  Before running this migration:
--
--   1. Confirm `lead_folio_counters` has columns:  date_key date PK,  last_folio int
--   2. Confirm `leads` has columns:
--        id uuid PK DEFAULT gen_random_uuid()
--        folio text UNIQUE NOT NULL
--        user_id uuid
--        categoria text
--        tipo text
--        descripcion text
--        lat numeric
--        lng numeric
--        colonia text
--        image_urls jsonb
--        priority int
--        assigned_to_area text
--        status text
--        extra jsonb
--        created_at timestamptz
--
--   If the real column names differ, UPDATE this file to match — do NOT invent
--   columns or rename existing ones.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. crear_lead function
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crear_lead(
  p_user_id          uuid,
  p_categoria        text,
  p_tipo             text,
  p_descripcion      text,
  p_lat              numeric,
  p_lng              numeric,
  p_colonia          text,
  p_image_urls       jsonb,
  p_priority         int     DEFAULT 2,
  p_assigned_to_area text    DEFAULT NULL,
  p_extra            jsonb   DEFAULT '{}'::jsonb
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
  -- The single INSERT … ON CONFLICT … RETURNING eliminates any race window:
  -- the counter value we read is the one we own.
  INSERT INTO lead_folio_counters (date_key, last_folio)
    VALUES (v_today, 1)
    ON CONFLICT (date_key)
    DO UPDATE SET last_folio = lead_folio_counters.last_folio + 1
    RETURNING last_folio INTO v_counter;

  -- Build folio: CUH-YYYYMMDD-NNN (zero-padded to 3 digits, e.g. CUH-20260424-001)
  v_folio := 'CUH-' || to_char(v_today, 'YYYYMMDD') || '-' || lpad(v_counter::text, 3, '0');

  -- Insert the lead and capture its generated UUID.
  INSERT INTO leads (
    folio,
    user_id,
    categoria,
    tipo,
    descripcion,
    lat,
    lng,
    colonia,
    image_urls,
    priority,
    assigned_to_area,
    status,
    extra,
    created_at
  ) VALUES (
    v_folio,
    p_user_id,
    p_categoria,
    p_tipo,
    p_descripcion,
    p_lat,
    p_lng,
    p_colonia,
    p_image_urls,
    p_priority,
    p_assigned_to_area,
    'open',
    p_extra,
    now()
  )
  RETURNING id INTO v_lead_id;

  RETURN QUERY SELECT v_folio, v_lead_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Grant execute to Supabase roles
-- ---------------------------------------------------------------------------

GRANT EXECUTE
  ON FUNCTION crear_lead(uuid, text, text, text, numeric, numeric, text, jsonb, int, text, jsonb)
  TO authenticated, service_role;
