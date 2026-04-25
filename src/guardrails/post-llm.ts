/**
 * Post-LLM guardrails: citation checking.
 *
 * `citationCheck` verifies that every phone number, folio, time, and address
 * mentioned in the LLM response can be traced back to one of the tool outputs
 * that were used to build that response.
 *
 * Hard-fail items (phone / folio / time not found → `missing`):
 *   These must be present verbatim in at least one tool output.
 *
 * Soft-fail items (address heuristic not found → `warnings`):
 *   Addresses are harder to normalise, so a missing address is reported as a
 *   warning rather than a hard failure.
 *
 * @example
 *   citationCheck(
 *     "Llama al 55-1234-5678 o visita calle Madero",
 *     [{ phone: "55-1234-5678", address: "Calle Morelos 10" }]
 *   );
 *   // → { ok: false, missing: [], warnings: ["calle Madero"] }
 *   //   (phone found → ok on phones; address not in outputs → warning)
 */

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

/** Matches phone-number-like sequences (MX domestic or international segments). */
const PHONE_RE = /\b\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;

/**
 * Strip URLs from a string before applying digit-based regexes.
 * URLs (https?://...) come verbatim from tool outputs — their coordinate digits
 * (e.g. origin=19.432600,-99.130000) are not invented by the LLM and must not
 * be flagged as phantom phone numbers.
 */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, ' ');
}

/** Matches Alcaldía Cuauhtémoc folio identifiers. */
const FOLIO_RE = /CUH-\d{8}-\d{3}/g;

/** Matches time expressions like 9:00 or 18:30. */
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;

/** Heuristic for address mentions — weak match, produces warnings not errors. */
const ADDRESS_RE =
  /(?:calle|av\.?|avenida|colonia)\s+[\w\sáéíóúñ]+/gi;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CitationCheckResult {
  /** True only when there are no hard-fail missing citations. */
  ok: boolean;
  /**
   * Phone numbers, folios, or times that appear in the response but cannot be
   * found in any tool output (hard fail).
   */
  missing: string[];
  /**
   * Address-like strings that appear in the response but cannot be found in
   * any tool output (soft warning).
   */
  warnings: string[];
}

/**
 * Checks that every specific datum in `responseText` (phones, folios, times,
 * addresses) is substantiated by at least one of the `toolOutputs`.
 *
 * @param responseText  The final text produced by the LLM.
 * @param toolOutputs   Array of objects returned by tool calls in this turn.
 *
 * @example
 *   // All citations grounded → clean pass
 *   citationCheck("Llama al 55-1234-5678", [{ phone: "55-1234-5678" }]);
 *   // → { ok: true, missing: [], warnings: [] }
 *
 * @example
 *   // Invented phone → hard fail
 *   citationCheck("Llama al 99-0000-0000", [{ phone: "55-1234-5678" }]);
 *   // → { ok: false, missing: ["99-0000-0000"], warnings: [] }
 *
 * @example
 *   // Time not in outputs → hard fail
 *   citationCheck("El evento es a las 10:00", [{ time: "09:00" }]);
 *   // → { ok: false, missing: ["10:00"], warnings: [] }
 *
 * @example
 *   // Address heuristic not grounded → soft warning only
 *   citationCheck("Pasa a calle Madero", [{ address: "Av. Juárez 10" }]);
 *   // → { ok: true, missing: [], warnings: ["calle Madero"] }
 *
 * @example
 *   // Folio grounded → clean pass
 *   citationCheck("Tu folio es CUH-20240101-001", [{ folio: "CUH-20240101-001" }]);
 *   // → { ok: true, missing: [], warnings: [] }
 *
 * @example
 *   // Empty response → nothing to check
 *   citationCheck("", []);
 *   // → { ok: true, missing: [], warnings: [] }
 */
export function citationCheck(
  responseText: string,
  toolOutputs: unknown[],
): CitationCheckResult {
  const outputsAsString = JSON.stringify(toolOutputs);

  const missing: string[] = [];
  const warnings: string[] = [];

  // ---- helper: check a set of matches ------------------------------------
  function checkMatches(
    re: RegExp,
    text: string,
    target: string[],
  ): void {
    // Reset lastIndex since we reuse compiled regexes.
    re.lastIndex = 0;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      if (!seen.has(value)) {
        seen.add(value);
        if (!outputsAsString.includes(value)) {
          target.push(value);
        }
      }
    }
  }

  // Hard-fail checks
  // Strip URLs before phone scan: coordinate digits inside a maps URL
  // (e.g. origin=19.432600,-99.130000) could otherwise match PHONE_RE.
  checkMatches(PHONE_RE, stripUrls(responseText), missing);
  checkMatches(FOLIO_RE, responseText, missing);
  checkMatches(TIME_RE, responseText, missing);

  // Soft-fail (address heuristic)
  checkMatches(ADDRESS_RE, responseText, warnings);

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  };
}
