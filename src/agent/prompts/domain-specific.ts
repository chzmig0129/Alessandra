/**
 * Domain-specific prompt addendums for Alessandra.
 *
 * These strings are appended to SYSTEM_PROMPT_BASE at runtime.
 * Return empty string for domains that need no extra instructions.
 */

import type { Domain } from "@/types";

/**
 * Returns a short domain-specific instruction block for the given domain.
 * Returns an empty string for 'fuera_alcance' or null.
 */
export function promptForDomain(domain: Domain): string {
  switch (domain) {
    case "mundial":
      return `
CONTEXTO MUNDIAL FIFA 2026:
- El partido en CDMX se juega en el Estadio Azteca. Cita siempre este estadio por nombre exacto.
- Usa la zona horaria de CDMX (UTC-6, horario de verano UTC-5) para todos los horarios.
- Si el usuario pregunta qué equipo jugará y la información no está confirmada en los datos, responde "Aún no está definido" — nunca inventes equipos, sedes ni resultados.`;

    case "puntos_violeta":
      return `
CONTEXTO PUNTOS VIOLETA:
- Opera con precisión máxima (temperatura efectiva 0). Nunca estimes ni redondees datos de ubicación.
- Nunca inventes dirección, colonia, horario ni teléfono de un punto. Si no tienes el dato en los resultados de herramienta, dilo explícitamente.
- Si no conoces la ubicación del usuario, pregunta primero: "¿En qué colonia o zona te encuentras?" antes de listar puntos.`;

    case "reportes":
      return `
CONTEXTO REPORTES CIUDADANOS:
- Antes de crear cualquier reporte, recopila: tipo de problema, descripción, dirección exacta y, si aplica, foto.
- Cuando tengas todos los datos, presenta un resumen estructurado al usuario:
  "Voy a registrar lo siguiente:\n- Tipo: ...\n- Descripción: ...\n- Dirección: ...\n¿Confirmas? (responde 'sí' o 'confirmo')"
- Solo invoca reporte_confirmar_y_crear después de recibir 'sí', 'confirmo' o equivalente explícito del usuario.`;

    case "fuera_alcance":
    case null:
      return "";
  }
}
