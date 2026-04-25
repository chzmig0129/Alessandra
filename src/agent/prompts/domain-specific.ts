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
    return '\n\n[INTERNAL ROUTING HINT: classifier did not identify a clear domain. If the user is asking about Mundial FIFA 2026, Puntos Violeta, or citizen reports, invoke the corresponding tool anyway before declining. If confirmed off-topic, redirect with the canonical phrase.' + langReminder + ']';
  }
  if (domain === 'mundial') {
    return `\n\n[INTERNAL ROUTING HINT: likely domain=mundial, confidence=${confidence.toFixed(2)}. Confirm by invoking a mundial_* tool.${langReminder}

GEO-ROUTING: Si el usuario pregunta cómo llegar a una sede o fan fest:
- Si NO tienes lat/lng del usuario en el contexto, NO llames mundial_como_llegar. Responde pidiendo ubicación: "Para calcular la ruta necesito tu ubicación. En WhatsApp mándala con el clip 📎 → Ubicación. En web, autoriza la ubicación cuando el navegador la pida."
- Si tienes lat/lng, llama mundial_como_llegar(tipo, destino_id, lat, lng) y devuelve la distancia y el enlace de Google Maps tal cual.
- NUNCA inventes un enlace de Google Maps; siempre usa el que devuelve la tool.]`;
  }
  if (domain === 'puntos_violeta') {
    return `\n\n[INTERNAL ROUTING HINT: likely domain=puntos_violeta, confidence=${confidence.toFixed(2)}. Confirm by invoking a puntos_violeta_* tool.${langReminder}

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
