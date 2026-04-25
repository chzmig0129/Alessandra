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
  return `\n\n[INTERNAL ROUTING HINT: likely domain=${domain}, confidence=${confidence.toFixed(2)}. Confirm by invoking a ${domain === 'mundial' ? 'mundial_*' : domain === 'puntos_violeta' ? 'puntos_violeta_*' : 'reporte_*'} tool.${langReminder}]`;
}

/**
 * @deprecated Use domainHint() instead.
 * Kept as an alias so any external callers continue to compile during migration.
 */
export function promptForDomain(domain: Domain): string {
  return domainHint(domain, 1.0);
}
