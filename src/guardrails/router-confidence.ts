/**
 * Router confidence scoring — heuristic domain classifier.
 *
 * `scoreDomain` produces a confidence score in [0, 1] for each known domain
 * by counting regex matches against the user text.  If a `flowSnapshot` is
 * provided and is not expired, the active domain receives a minimum boost to
 * encourage conversation stickiness.
 *
 * Consumers should use `DOMAIN_THRESHOLD` (0.4) to decide whether any domain
 * has enough confidence to be asserted, or whether to fall back to a LLM
 * classifier.
 *
 * @example
 *   scoreDomain("¿dónde queda el estadio?");
 *   // → { mundial: 0.3, puntos_violeta: 0, reportes: 0, fuera_alcance: 0 }
 *
 * @example
 *   scoreDomain("hay un bache frente a mi casa");
 *   // → { mundial: 0, puntos_violeta: 0, reportes: 0.3, fuera_alcance: 0 }
 *
 * @example
 *   // Stickiness: active flow boosts its domain
 *   scoreDomain("ok, continúa", { domain: "reportes", step: "confirm", ... });
 *   // → { mundial: 0, puntos_violeta: 0, reportes: 0.85, fuera_alcance: 0 }
 */

import { isFlowExpired, type Flow } from "@/memory/flow-state";
import type { Domain } from "@/types";

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

/**
 * Minimum score required for a domain to be asserted by the router.
 * Scores below this value are treated as inconclusive.
 */
export const DOMAIN_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Per-domain heuristic patterns
// ---------------------------------------------------------------------------

const DOMAIN_PATTERNS: Record<NonNullable<Exclude<Domain, null>>, RegExp> = {
  mundial: /partido|mundial|fifa|estadio|fan fest|copa/i,
  puntos_violeta: /violeta|mujer|emergencia|seguridad|protección|acoso/i,
  reportes: /bache|alumbrado|basura|fuga|árbol|cable|reportar|denunciar|folio/i,
  fuera_alcance: /(?:)/,  // never matches — kept for structural completeness
};

/** Score cap per domain. */
const MAX_SCORE = 1.0;

/** Score increment per unique keyword match. */
const MATCH_WEIGHT = 0.3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a confidence score in [0, 1] for every domain, given `text` and an
 * optional active `flowSnapshot`.
 *
 * Scoring algorithm:
 * 1. For `mundial`, `puntos_violeta`, and `reportes`: count the number of
 *    unique regex matches (`MATCH_WEIGHT` each, capped at `MAX_SCORE`).
 * 2. `fuera_alcance` always scores 0 — it is a sentinel, not a scored domain.
 * 3. If `flowSnapshot` is provided and not expired, the snapshot's domain
 *    is boosted to at least 0.85 (stickiness).
 *
 * @param text          The user's incoming message.
 * @param flowSnapshot  The current conversation flow (optional).
 *
 * @example
 *   scoreDomain("¿el fan fest abre mañana?");
 *   // → { mundial: 0.3, puntos_violeta: 0, reportes: 0, fuera_alcance: 0 }
 *
 * @example
 *   scoreDomain("me acosan en el trabajo");
 *   // → { mundial: 0, puntos_violeta: 0.6, reportes: 0, fuera_alcance: 0 }
 *
 * @example
 *   // Flow stickiness overrides low heuristic score
 *   const activeFlow: Flow = {
 *     domain: "reportes",
 *     step: "confirm_address",
 *     slots: {},
 *     started_at: new Date().toISOString(),
 *     expires_at: new Date(Date.now() + 300_000).toISOString(),
 *     intent_snapshot: "bache",
 *   };
 *   scoreDomain("sí, esa es la dirección", activeFlow);
 *   // → { mundial: 0, puntos_violeta: 0, reportes: 0.85, fuera_alcance: 0 }
 */
export function scoreDomain(
  text: string,
  flowSnapshot?: Flow | null,
): Record<NonNullable<Exclude<Domain, null>>, number> {
  const scores: Record<NonNullable<Exclude<Domain, null>>, number> = {
    mundial: 0,
    puntos_violeta: 0,
    reportes: 0,
    fuera_alcance: 0,
  };

  // ---- heuristic scoring (mundial / puntos_violeta / reportes) -----------
  const scoredDomains = [
    "mundial",
    "puntos_violeta",
    "reportes",
  ] as const;

  for (const domain of scoredDomains) {
    const pattern = DOMAIN_PATTERNS[domain];
    // Collect unique matches.
    const allMatches = text.match(new RegExp(pattern.source, "gi"));
    const uniqueCount = allMatches
      ? new Set(allMatches.map((m) => m.toLowerCase())).size
      : 0;

    scores[domain] = Math.min(uniqueCount * MATCH_WEIGHT, MAX_SCORE);
  }

  // ---- stickiness boost --------------------------------------------------
  if (
    flowSnapshot != null &&
    flowSnapshot.domain != null &&
    !isFlowExpired(flowSnapshot)
  ) {
    const stickDomain = flowSnapshot.domain as NonNullable<
      Exclude<Domain, null>
    >;
    if (stickDomain !== "fuera_alcance") {
      scores[stickDomain] = Math.max(scores[stickDomain], 0.85);
    }
  }

  return scores;
}
