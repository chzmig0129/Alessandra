/**
 * Domain-specific prompt hints for Alessandra.
 *
 * Instead of large per-domain instruction blocks, we now append a short
 * classification hint so the agent knows which tool family to reach for first.
 * Full tool instructions live in the .describe() fields of each tool's schema.
 */

import type { Domain } from "@/types";

/**
 * Returns a short classification hint string to append to SYSTEM_PROMPT_BASE.
 *
 * For null / fuera_alcance the hint reminds the agent to still try a tool
 * before declaring out-of-scope.
 */
export function domainHint(domain: Domain, confidence: number): string {
  const langReminder = ' Reply in the same language as the user message above (es/en/pt/fr/it).';
  if (domain == null || domain === 'fuera_alcance') {
    return `\n\n[INTERNAL ROUTING HINT: classifier did not identify a clear domain.

OBLIGATORIO antes de declinar o decir "no tengo información":
1. Invoca knowledge_buscar({query: "<pregunta del usuario tal cual>"}) — la base tiene 329 documentos curados sobre Cuauhtémoc/CDMX (museos, gastronomía, salud, deportes, números de emergencia, trámites detallados, eventos, info_general). Datos como "número de Base Diana", "qué museos visitar", "requisitos del trámite X" están AHÍ.
2. Si knowledge_buscar devuelve resultados con similarity > 0.4, redacta usando content_snippet (NO summary — los datos concretos como teléfonos están en content_snippet).
3. Si knowledge_buscar devuelve vacío o irrelevante, intenta consulta_analitica_sql como segundo fallback.
4. Solo si AMBOS fallback están vacíos, usa la frase canónica de redirección.

NO declines en el primer turno sin haber invocado knowledge_buscar al menos una vez.${langReminder}]`;
  }
  if (domain === 'mundial') {
    return `\n\n[INTERNAL ROUTING HINT: likely domain=mundial, confidence=${confidence.toFixed(2)}. Confirm by invoking a mundial_* tool.${langReminder}

EJECUCIÓN DIRECTA — sin pedir permiso:
- Si el usuario pregunta por un JUGADOR (Messi, Mbappé, Cristiano, Neymar, Lewandowski, Modrić, Bellingham, Kane, Yamal, Pedri, De Bruyne, Son, Lautaro, Rodrygo, Vinícius, etc.), MAPEA mentalmente jugador→selección y EJECUTA mundial_partidos_buscar({equipo:'<nombre selección en inglés>'}) en este MISMO turn. Devuelve la lista directamente con una nota tipo "Mbappé juega con Francia. Sus partidos son: ...".
- PROHIBIDO responder "¿Te gustaría que busque los partidos de X?" cuando ya identificaste la selección. Eso es perder el turn. Solo busca. El usuario YA dijo que quiere los partidos.
- PROHIBIDO responder "no tengo información sobre Mbappé" — sí la tienes (sus partidos = los de Francia).
- Equipo en mundial_partidos_buscar acepta nombres en inglés: 'Argentina', 'France', 'Portugal', 'Brazil', 'England', 'Spain', 'Belgium', 'Korea Republic', 'Croatia', 'Poland'.

GEO-ROUTING: Si el usuario pregunta cómo llegar a una sede o fan fest:
- Si NO tienes lat/lng del usuario en el contexto, NO llames mundial_como_llegar. Responde pidiendo ubicación: "Para calcular la ruta necesito tu ubicación. En WhatsApp mándala con el clip 📎 → Ubicación. En web, autoriza la ubicación cuando el navegador la pida."
- Si tienes lat/lng, sigue estos dos pasos en orden:
  PASO 1: Si el usuario menciona el destino por nombre (ej. "Estadio Azteca", "Fan Fest del Zócalo"), PRIMERO llama mundial_sede_info o mundial_fan_fest para obtener el id numérico del destino. Usa el campo 'id' del resultado como destino_id.
  PASO 2: Con ese destino_id numérico en mano, llama mundial_como_llegar(tipo, destino_id, lat, lng) y devuelve la distancia y el enlace de Google Maps tal cual.
- NUNCA inventes un enlace de Google Maps; siempre usa el que devuelve la tool.]`;
  }
  if (domain === 'puntos_violeta') {
    return `\n\n[INTERNAL ROUTING HINT: likely domain=puntos_violeta, confidence=${confidence.toFixed(2)}. Confirm by invoking a puntos_violeta_* tool.${langReminder}

QUÉ SON LOS PUNTOS VIOLETA — contexto que SIEMPRE debes dar al presentar resultados:
La red de Puntos Violeta de la Alcaldía Cuauhtémoc es una red de ESPACIOS SEGUROS donde mujeres en situación de violencia o riesgo pueden recibir apoyo, llamar al 911, esperar ayuda, o pedir asistencia. La red incluye TRES tipos de puntos:
- Comercios participantes (farmacias, restaurantes, tiendas) capacitados para auxiliar — el campo tipo_atencion dice "Comercio".
- Puntos institucionales (oficinas de la alcaldía, centros culturales) — tipo_atencion: "Punto violeta".
- Otros (clínicas, escuelas) según tipo_atencion devuelto.
Cuando regreses la lista, ENMARCA explícitamente que son parte de la red oficial de Puntos Violeta. Ej: "Aquí tienes Puntos Violeta cerca de ti — son espacios seguros de la red oficial donde puedes recibir auxilio. Incluye tanto comercios participantes como espacios institucionales:" y luego la lista. Si un row es comercio, dilo claro: "Farmacia Similares (comercio Punto Violeta)". El usuario debe entender que NO te equivocaste — los comercios son parte legítima de la red.

GEO-ROUTING: Cuando el usuario pregunte por el punto violeta más cercano:
- Si NO tienes lat/lng: pide ubicación con el mismo formato: "Para calcular la ruta necesito tu ubicación. En WhatsApp mándala con el clip 📎 → Ubicación. En web, autoriza la ubicación cuando el navegador la pida."
- Si sí: llama puntos_violeta_buscar con lat/lng. El resultado incluye distance_km y maps_url para cada row — preséntalos al usuario.
- NUNCA inventes un enlace de Google Maps; siempre usa el maps_url que devuelve la tool.]`;
  }
  return `\n\n[INTERNAL ROUTING HINT: likely domain=${domain}, confidence=${confidence.toFixed(2)}. Confirm by invoking a reporte_* tool.${langReminder}]`;
}

/**
 * @deprecated Use domainHint() instead.
 * Kept as an alias so any external callers continue to compile during migration.
 */
export function promptForDomain(domain: Domain): string {
  return domainHint(domain, 1.0);
}
