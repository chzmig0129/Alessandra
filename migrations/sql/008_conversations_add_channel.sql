-- Migration: 008_conversations_add_channel
-- Description: Agrega columna 'channel' a la tabla conversations para soportar
--   múltiples canales sobre la misma tabla: whatsapp, web, voice.
--   Las conversaciones existentes quedan con channel='whatsapp' (canal original).
--
-- Valores posibles para 'channel':
--   'whatsapp' — mensajes entrantes via Twilio/WhatsApp
--   'web'      — chat embebido en sitio web (app/api/chat)
--   'voice'    — llamadas de voz via ElevenLabs Agents
--
-- Apply: psql $SUPABASE_DB_URL -f migrations/sql/008_conversations_add_channel.sql
--
-- This migration is idempotent: safe to run multiple times without side effects.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp', 'web', 'voice'));

COMMENT ON COLUMN conversations.channel IS
  'Canal de origen de la conversación. Valores posibles: whatsapp | web | voice.';

-- Index para filtrar/agrupar por canal en reportes y queries de session lookup.
CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations (channel);
