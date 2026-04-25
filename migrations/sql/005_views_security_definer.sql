-- Migration: 005_views_security_definer
-- Description: Switch all v_* views from security_invoker=true to security_invoker=false
--   so the sql_sandbox role (and the readonly_alessandra user that inherits it)
--   can SELECT from them without needing SELECT on every underlying table.
--
-- Rationale: the v_* views are explicitly designed to expose only public catalogue
--   data (sedes, equipos, partidos, tramites, puntos_violeta, etc.). Running them
--   with the owner's privileges (security_invoker=false, the default) is safe and
--   removes the need to grant table-level SELECT to every analyst role.
--
-- Discovered: text-to-SQL fallback was rejected with "permission denied for table sedes"
--   on every attempt because v_mundial_sedes was running as the invoker (sandbox role)
--   which had SELECT on the view but not on "mundial-fifa".sedes.
--
-- Apply: psql $SUPABASE_DB_URL -f migrations/sql/005_views_security_definer.sql

ALTER VIEW v_cartelera_events SET (security_invoker = false);
ALTER VIEW v_cartelera_venues SET (security_invoker = false);
ALTER VIEW v_emergency_contacts SET (security_invoker = false);
ALTER VIEW v_leads_publico SET (security_invoker = false);
ALTER VIEW v_mundial_alineaciones SET (security_invoker = false);
ALTER VIEW v_mundial_equipos SET (security_invoker = false);
ALTER VIEW v_mundial_eventos_partido SET (security_invoker = false);
ALTER VIEW v_mundial_fan_fest SET (security_invoker = false);
ALTER VIEW v_mundial_partidos SET (security_invoker = false);
ALTER VIEW v_mundial_sedes SET (security_invoker = false);
ALTER VIEW v_puntos_violeta SET (security_invoker = false);
ALTER VIEW v_report_taxonomy SET (security_invoker = false);
ALTER VIEW v_security_facilities SET (security_invoker = false);
ALTER VIEW v_tramites SET (security_invoker = false);
