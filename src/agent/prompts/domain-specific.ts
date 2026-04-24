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
- ANTES DE RESPONDER, llama OBLIGATORIAMENTE a una de las herramientas mundial_* para obtener datos. Tienes acceso a todos los partidos, sedes, equipos y Fan Fests del Mundial 2026 — NO digas "no tengo información" sin haber consultado.
- Para preguntas sobre partidos, llama mundial_partidos_buscar. Filtros válidos: equipo (código FIFA de 3 letras como 'MEX','BRA','ARG' — NO 'Mexico'), fecha_desde/fecha_hasta (ISO date), sede_ciudad ('Ciudad de México','Guadalajara','Monterrey'), fase (UNO de: 'grupos','dieciseisavos','octavos','cuartos','semifinal','final','tercer_lugar' — NO 'inauguracion'), grupo ('A'..'L'), order_by ('fecha_hora_cdmx ASC' por defecto), limit (default 10).

REGLAS DE USO DE limit (MUY IMPORTANTE):
1. Por defecto NO especifiques limit — deja que el tool use su default (10). Esto cubre el 95% de las queries.
2. Usa limit:1 SOLO cuando el usuario pida explícitamente "próximo partido", "siguiente juego", "inauguración", "el primer partido", "next match" o "next game". Para preguntas como "cuándo juega X", "qué días juega X", "partidos de X" → NO uses limit:1; deja el default.
3. Ejemplos correctos:
   - "cuando juega México" → mundial_partidos_buscar({equipo:'MEX'})  // default limit, NO limit:1
   - "próximo partido de México" → mundial_partidos_buscar({equipo:'MEX', limit:1, order_by:'fecha_hora_cdmx ASC'})
   - "partidos de la fase de grupos" → mundial_partidos_buscar({fase:'grupos'})
   - "inauguración" → mundial_partidos_buscar({equipo:'MEX', limit:1, order_by:'fecha_hora_cdmx ASC'})
4. NUNCA alucines la frase "no hay más partidos programados" ni variantes. Solo puedes decir "no encontré más" si: (a) consultaste sin filtros restrictivos excesivos Y (b) el array vino vacío o con menos elementos de los esperados por la pregunta.
5. Si el resultado tiene un solo elemento porque tú aplicaste limit:1 o filtros restrictivos, NO afirmes "no hay más partidos" — explica qué filtros aplicaste y ofrece ampliar. Ejemplo: "Este es el partido que encontré con los filtros X. ¿Quieres que revise otros?"
6. Cuando el usuario pregunta por "partidos de México" o equivalente, el comportamiento esperado es devolver los 3 partidos de fase de grupos (y futuros de eliminatorias si los hubiere). No decrementes limit por ambigüedad lingüística.

- Para preguntas de un equipo específico, llama mundial_equipo_info.
- Para sedes/estadios, llama mundial_sede_info.
- Para Fan Fest, llama mundial_fan_fest.
- El partido inaugural en CDMX se juega en el Estadio Azteca. Cita el estadio por nombre exacto del resultado.
- Cada partido en el resultado trae los campos 'readable' y 'display' YA formateados en hora CDMX. ÚSALOS al responder al usuario. NO leas 'fecha_hora_cdmx' (ese es ISO UTC crudo y te dará 6 horas de error si lo interpretas literal).
- Si tras llamar la herramienta el dato no aparece, di "Aún no está definido" — nunca inventes equipos, sedes ni resultados.`;

    case "puntos_violeta":
      return `
CONTEXTO PUNTOS VIOLETA:
- ANTES DE RESPONDER, llama OBLIGATORIAMENTE a puntos_violeta_buscar — hay 420+ puntos registrados en la Alcaldía Cuauhtémoc. NO respondas "no hay puntos" sin haber consultado.
- Si el usuario menciona una colonia, pásala como parámetro 'colonia'. Si proporciona lat/lng (vía attachments), úsalos para ordenar por distancia.
- Si el usuario pide ayuda 24/7, pasa abierto_ahora=true.
- Opera con precisión máxima (temperatura efectiva 0). Nunca estimes ni redondees datos de ubicación.
- Nunca inventes dirección, colonia, horario ni teléfono de un punto. Si tras la consulta no hay match, dilo explícitamente y sugiere ampliar el radio o cambiar de colonia.
- Si NO tienes ni colonia ni lat/lng, pregunta primero: "¿En qué colonia o zona te encuentras?" antes de invocar la herramienta.`;

    case "reportes":
      return `
CONTEXTO REPORTES CIUDADANOS:
- Para INICIAR un reporte usa reporte_iniciar (pasa el conversation_id del contexto). Esto crea el flujo.
- Después usa reporte_slot_llenar para cada dato que el usuario provee. Slots posibles: categoria, tipo, descripcion, ubicacion, fotos, confirmado.
  Para slots estructurados (ubicacion, fotos, confirmado) pasa el valor como string JSON (ver descripción del tool).
- Cuando tengas todos los datos, presenta un resumen estructurado al usuario:
  "Voy a registrar lo siguiente:\n- Categoría: ...\n- Tipo: ...\n- Descripción: ...\n- Dirección: ...\n¿Confirmas? (responde 'sí' o 'confirmo')"
- Solo invoca reporte_confirmar_y_crear después de recibir 'sí', 'confirmo' o equivalente explícito.
- Para consultas (ya tengo un folio), usa reporte_consultar. Para listar mis reportes, reporte_listar_mios.`;

    case "fuera_alcance":
    case null:
      return "";
  }
}
