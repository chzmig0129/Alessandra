/**
 * Unit tests for citationCheck (src/guardrails/post-llm.ts).
 *
 * No external dependencies — citationCheck is a pure function.
 */

import { describe, it, expect } from "vitest";
import { citationCheck } from "@/guardrails/post-llm";

describe("citationCheck", () => {
  // -------------------------------------------------------------------------
  // Case 1: phone present in tool output → OK
  // -------------------------------------------------------------------------
  it("Case 1 — phone present in tool output → ok:true, empty missing", () => {
    const result = citationCheck(
      "Llama al 55-1234-5678 para más información.",
      [{ phone: "55-1234-5678", info: "Centro de atención" }],
    );

    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 2: phone in response NOT in any tool output → missing (hard fail)
  // -------------------------------------------------------------------------
  it("Case 2 — invented phone not in tool outputs → ok:false, phone in missing", () => {
    const result = citationCheck(
      "Llama al 99-0000-0000 para más información.",
      [{ phone: "55-1234-5678" }],
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain("99-0000-0000");
  });

  // -------------------------------------------------------------------------
  // Case 3: folio CUH-... present in tool output → OK
  // -------------------------------------------------------------------------
  it("Case 3 — folio grounded in tool output → ok:true", () => {
    const result = citationCheck(
      "Tu reporte quedó registrado con folio CUH-20260424-001.",
      [{ folio: "CUH-20260424-001", status: "open" }],
    );

    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 4: folio in response NOT in tool outputs → missing (hard fail)
  // -------------------------------------------------------------------------
  it("Case 4 — folio not grounded → ok:false, folio in missing", () => {
    const result = citationCheck(
      "Tu folio es CUH-20991231-999.",
      [{ folio: "CUH-20260424-001" }],
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain("CUH-20991231-999");
  });

  // -------------------------------------------------------------------------
  // Case 5: invented time not in tool outputs → hard fail
  // -------------------------------------------------------------------------
  it("Case 5 — invented horario not grounded → ok:false, time in missing", () => {
    const result = citationCheck(
      "El evento es a las 10:00.",
      [{ schedule: "horario: 09:00 a 14:00" }],
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain("10:00");
  });

  // -------------------------------------------------------------------------
  // Case 6: address heuristic not grounded → warning only (ok stays true)
  // -------------------------------------------------------------------------
  it("Case 6 — address not grounded → ok:true, warning recorded", () => {
    const result = citationCheck(
      "Pasa a calle Madero para tramitarlo.",
      [{ address: "Av. Juárez 10, Centro" }],
    );

    // Address is a soft-fail: ok should be true since no hard-fail.
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    // The warning should mention "calle madero" (case-insensitive check)
    const warningsLower = result.warnings.map((w) => w.toLowerCase());
    expect(warningsLower.some((w) => w.includes("calle"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 7: empty toolOutputs + response with no citations → ok:true
  // -------------------------------------------------------------------------
  it("Case 7 — empty toolOutputs and response with no citations → ok:true", () => {
    const result = citationCheck(
      "No hay información disponible en este momento.",
      [],
    );

    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 8: empty response → ok:true with nothing to check
  // -------------------------------------------------------------------------
  it("Case 8 — empty response string → ok:true", () => {
    const result = citationCheck("", [{ phone: "55-1234-5678" }]);

    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 9: time grounded in tool output → ok:true
  // -------------------------------------------------------------------------
  it("Case 9 — time grounded in tool output → ok:true", () => {
    const result = citationCheck(
      "El horario de atención es de 9:00 a 18:00.",
      [{ schedule: "9:00 a 18:00" }],
    );

    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});
