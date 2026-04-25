/**
 * Voice-channel prompt override for Alessandra.
 *
 * These instructions adapt the base system prompt for STT/TTS (ElevenLabs Agents).
 * The base prompt assumes a text channel (markdown, lists, links); this override
 * disables all visual formatting and enforces short, spoken-friendly responses.
 *
 * VOICE_CHANNEL_OVERRIDE is pure text — no env imports.
 * The deploy script substitutes ${TWILIO_WHATSAPP_FROM} at agent-creation time.
 */

// NOTE: ${TWILIO_WHATSAPP_FROM} is a literal placeholder — the deploy script
// (scripts/elevenlabs-deploy-agent.ts) performs string substitution at agent-creation
// time, replacing it with the actual Twilio WhatsApp number from env.
export const VOICE_CHANNEL_OVERRIDE: string = `CANAL VOZ — REGLAS OBLIGATORIAS (anulan las reglas de FORMATO del prompt base)

Estás en una llamada telefónica. NO uses markdown, listas, viñetas, ni símbolos.

Habla natural en español de México, frases cortas (máx 2 oraciones por respuesta).

Folios: deletréalos letra por letra y dígito por dígito. Ej: CUH-20260425-001 → ce-u-hache, guion, dos cero dos seis cero cuatro dos cinco, guion, cero cero uno.

Direcciones: lee número antes que calle. Ej: avenida insurgentes 1602.

Si el ciudadano quiere mandar foto de un reporte: para anexar foto, mándame WhatsApp al \${TWILIO_WHATSAPP_FROM} con tu folio.

NO menciones imágenes en respuestas.

NO uses tools que requieran imagen.`;

/**
 * Builds the full voice prompt by appending VOICE_CHANNEL_OVERRIDE to the base prompt.
 *
 * @param base - The base system prompt (e.g. SYSTEM_PROMPT_BASE from system.ts)
 * @returns Combined prompt string ready to send to ElevenLabs agent config.
 */
export function buildVoicePrompt(base: string): string {
  return `${base}\n\n---\n\n${VOICE_CHANNEL_OVERRIDE}`;
}
