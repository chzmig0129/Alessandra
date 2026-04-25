-- Migration: 008_conversations_add_channel
-- Description: Garantiza que la tabla conversations tenga una columna 'channel'
--   con DEFAULT 'whatsapp' y CHECK constraint que limita los valores a:
--     'whatsapp' — mensajes entrantes via Twilio/WhatsApp
--     'web'      — chat embebido en sitio web (app/api/chat)
--     'voice'    — llamadas de voz via ElevenLabs Agents
--
-- En algunos entornos la columna ya existe (NOT NULL TEXT) pero sin DEFAULT ni
-- CHECK; en otros la columna no existe todavía. Esta migration cubre ambos
-- casos y es idempotente: segura de re-ejecutar.
--
-- Apply via Supabase MCP (apply_migration) o psql.

-- 1. Crear la columna si no existe (cubre entornos limpios).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

-- 2. Asegurar el DEFAULT en entornos donde la columna ya existía sin uno.
ALTER TABLE conversations
  ALTER COLUMN channel SET DEFAULT 'whatsapp';

-- 3. CHECK constraint enumerado. Drop+create para idempotencia (DROP IF EXISTS).
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_channel_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check
    CHECK (channel IN ('whatsapp', 'web', 'voice'));

-- 4. Documentación de columna.
COMMENT ON COLUMN conversations.channel IS
  'Canal de origen de la conversación. Valores posibles: whatsapp | web | voice.';

-- 5. Index para filtrar/agrupar por canal en reportes y queries de session lookup.
CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations (channel);
