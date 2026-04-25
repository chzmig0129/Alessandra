/**
 * voice-tools-allowlist.ts
 *
 * Explicit list of ALL_TOOLS keys that are permitted on the voice channel.
 *
 * Excluded from voice:
 *   - reporte_analizar_imagen: requires image upload, not applicable to voice.
 *
 * Note: reporte_slot_llenar IS included here, but the voice-tools route
 * enforces an additional guard: if args.slot === 'fotos', it returns 400 with a
 * voice-friendly redirect message ("Para anexar foto, mande WhatsApp con su folio").
 */

export const VOICE_TOOL_ALLOWLIST: readonly string[] = [
  // Mundial (6)
  "mundial_partidos_buscar",
  "mundial_sede_info",
  "mundial_fan_fest",
  "mundial_partido_detalle",
  "mundial_equipo_info",
  "mundial_como_llegar",
  // Puntos Violeta (2 + emergency)
  "puntos_violeta_buscar",
  "puntos_violeta_detalle",
  "emergencia_mujer_canalizar",
  // Reportes — 6 (reporte_analizar_imagen is excluded)
  "reporte_iniciar",
  "reporte_slot_llenar",
  "reporte_confirmar_y_crear",
  "reporte_cancelar",
  "reporte_consultar",
  "reporte_listar_mios",
  // Shared
  "consulta_analitica_sql",
  "knowledge_buscar",
] as const;
