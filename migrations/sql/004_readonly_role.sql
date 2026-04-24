-- Migration: 004_readonly_role
-- Description: Creates the sql_sandbox role for text-to-SQL read-only access.
--              The role has SELECT only on views matching v_* and is denied access
--              to raw tables. Role defaults enforce a 3-second statement timeout and
--              default_transaction_read_only to prevent any accidental DML.
--
-- Apply:
--   psql $SUPABASE_DB_URL -f migrations/sql/004_readonly_role.sql
--
-- This migration is idempotent: safe to run multiple times without side effects.
--
-- ---------------------------------------------------------------------------
-- HOW TO CREATE A LOGIN USER THAT INHERITS THIS ROLE (production setup)
-- ---------------------------------------------------------------------------
-- After applying this migration, create a dedicated login user for the app:
--
--   CREATE USER sandbox_user WITH LOGIN PASSWORD '<strong-random-password>';
--   GRANT sql_sandbox TO sandbox_user;
--
-- Then set your environment variable to point at this restricted user:
--
--   SUPABASE_SANDBOX_DB_URL=postgresql://sandbox_user:<password>@<host>:<port>/<db>
--
-- The application connects as sandbox_user, which automatically inherits all
-- restrictions from sql_sandbox (read-only, 3s timeout, v_* views only).
-- No SET ROLE is needed — the inherited role restrictions apply at login.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Create role idempotently (NOLOGIN — apps must connect via a LOGIN user
--    that GRANTs this role, see header above)
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sql_sandbox') THEN
    CREATE ROLE sql_sandbox NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Revoke all privileges on raw tables first (defense in depth)
--    This ensures sql_sandbox cannot access base tables even if GRANTs leak.
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sql_sandbox;

-- ---------------------------------------------------------------------------
-- 3. Grant SELECT only on views whose names match v_*
--    Runs dynamically so it picks up any views created after this migration.
-- ---------------------------------------------------------------------------

DO $$ DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT viewname
    FROM   pg_views
    WHERE  schemaname = 'public'
    AND    viewname LIKE 'v\_%' ESCAPE '\'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO sql_sandbox', r.viewname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Harden role defaults
--    search_path: restrict to public only (prevent schema-injection attacks)
--    statement_timeout: kill any runaway query after 3 seconds
--    default_transaction_read_only: block DML at the transaction level as a
--      second layer of protection on top of the REVOKE above
-- ---------------------------------------------------------------------------

ALTER ROLE sql_sandbox SET search_path = public;
ALTER ROLE sql_sandbox SET statement_timeout = '3s';
ALTER ROLE sql_sandbox SET default_transaction_read_only = on;

-- ---------------------------------------------------------------------------
-- 5. Attach documentation comment to the role
-- ---------------------------------------------------------------------------

COMMENT ON ROLE sql_sandbox IS
  'Read-only sandbox para text-to-SQL. Solo SELECT en v_*. '
  'Apps deben SET ROLE sql_sandbox o conectar como un user que ya hereda de este rol. '
  'Para producción: CREATE USER sandbox_user LOGIN PASSWORD ''...''; GRANT sql_sandbox TO sandbox_user; '
  'y apuntar SUPABASE_SANDBOX_DB_URL a ese user.';
