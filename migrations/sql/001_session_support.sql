-- Migration: 001_session_support
-- Description: Adds session flow tracking columns to conversations table and creates
--              unanswered_questions table for observability and continuous improvement.
--
-- Apply:
--   psql $SUPABASE_DB_URL -f migrations/sql/001_session_support.sql
--
-- This migration is idempotent: safe to run multiple times without side effects.

-- ---------------------------------------------------------------------------
-- 1. Extend conversations table with session/flow tracking columns
-- ---------------------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS current_flow jsonb,
  ADD COLUMN IF NOT EXISTS expires_at   timestamptz;

-- Index to quickly find active conversations per user.
-- Postgres requires immutable predicates for partial indexes, so we use
-- `expires_at IS NOT NULL` (broader but still narrows out null-expires rows)
-- instead of `expires_at > now()` (which is non-immutable and rejected).
CREATE INDEX IF NOT EXISTS idx_conversations_user_active
  ON conversations (user_id, expires_at DESC)
  WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Create unanswered_questions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS unanswered_questions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        REFERENCES users (id) ON DELETE SET NULL,
  conversation_id  uuid        REFERENCES conversations (id) ON DELETE SET NULL,
  question         text        NOT NULL,
  detected_intent  text,
  tools_attempted  jsonb,
  sql_generated    text,
  resolution       text        CHECK (
                                 resolution IS NULL
                                 OR resolution IN ('rechazo', 'sql_ok', 'sql_fail', 'error')
                               ),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Lock down: only service_role (which bypasses RLS) can read/write.
-- We never expose this table via PostgREST anon/authenticated keys.
ALTER TABLE public.unanswered_questions ENABLE ROW LEVEL SECURITY;
