-- Migration: 007_crear_lead_dual_location
-- Description: crear_lead() ahora escribe location_address Y location (con el
--   mismo valor) — el dashboard /reportes renderiza la columna `location`
--   (legacy text) y mostraba "—" cuando solo se llenaba location_address.
--
-- Apply: psql $SUPABASE_DB_URL -f migrations/sql/007_crear_lead_dual_location.sql

CREATE OR REPLACE FUNCTION public.crear_lead(
  p_conversation_id uuid, p_user_id uuid, p_category text, p_report_type text, p_report text,
  p_lat double precision, p_lng double precision, p_location_address text,
  p_media_urls text[], p_priority smallint DEFAULT 2,
  p_severity text DEFAULT NULL, p_tags text[] DEFAULT NULL,
  p_incident_subtype text DEFAULT NULL, p_ai_analysis jsonb DEFAULT NULL
)
RETURNS TABLE(folio text, lead_id uuid)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Mexico_City')::date;
  v_counter int;
  v_folio text;
  v_lead_id uuid;
BEGIN
  INSERT INTO lead_folio_counters (fecha, last_seq) VALUES (v_today, 1)
    ON CONFLICT (fecha) DO UPDATE SET last_seq = lead_folio_counters.last_seq + 1
    RETURNING last_seq INTO v_counter;
  v_folio := 'CUH-' || to_char(v_today, 'YYYYMMDD') || '-' || lpad(v_counter::text, 3, '0');
  INSERT INTO leads (
    folio, conversation_id, user_id, category, report_type, report,
    lat, lng, location_address, location, media_urls, priority,
    severity, tags, incident_subtype, ai_analysis, status
  ) VALUES (
    v_folio, p_conversation_id, p_user_id, p_category, p_report_type, p_report,
    p_lat, p_lng, p_location_address, p_location_address, p_media_urls, p_priority,
    p_severity, p_tags, p_incident_subtype, p_ai_analysis, 'pending_review'::lead_status
  ) RETURNING id INTO v_lead_id;
  RETURN QUERY SELECT v_folio, v_lead_id;
END;
$function$;
