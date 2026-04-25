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
  if (domain == null || domain === 'fuera_alcance') {
    return '\n\n[CLASSIFICATION_HINT: clasificador no identificó dominio claro. Si el usuario pregunta sobre Mundial 2026, Puntos Violeta o Reportes, invoca la tool correspondiente igualmente. Si confirma fuera de alcance, redirige.]';
  }
  return `\n\n[CLASSIFICATION_HINT: dominio probable=${domain}, confianza=${confidence.toFixed(2)}. Confirma invocando una tool ${domain === 'mundial' ? 'mundial_*' : domain === 'puntos_violeta' ? 'puntos_violeta_*' : 'reporte_*'}.]`;
}

/**
 * @deprecated Use domainHint() instead.
 * Kept as an alias so any external callers continue to compile during migration.
 */
export function promptForDomain(domain: Domain): string {
  return domainHint(domain, 1.0);
}
