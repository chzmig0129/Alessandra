/**
 * Unit tests for validateAndNormaliseSql (src/tools/shared/sql-sandbox.ts).
 *
 * The function is exported from sql-sandbox.ts specifically for testability.
 * No DB connection is needed — the validator is pure (no async, no I/O).
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock external dependencies that sql-sandbox.ts imports at module level.
// We mock @/db/supabase-server and @mastra/core/tools so that importing the
// module does not require a real Supabase client or Mastra runtime.
// ---------------------------------------------------------------------------

vi.mock("@/db/supabase-server", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  },
}));

vi.mock("@mastra/core/tools", () => ({
  createTool: vi.fn((config) => config),
}));

// Import AFTER mocks are set up.
import { validateAndNormaliseSql } from "@/tools/shared/sql-sandbox";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateAndNormaliseSql", () => {
  // -------------------------------------------------------------------------
  // Case 1: SELECT against a v_* view → accepted, returned as-is (with LIMIT)
  // -------------------------------------------------------------------------
  it("Case 1 — SELECT v_x → accepted and LIMIT 100 injected", () => {
    const sql = "SELECT id, nombre FROM v_leads";
    const result = validateAndNormaliseSql(sql);

    expect(result).toContain("LIMIT 100");
    expect(result).toContain("v_leads");
  });

  // -------------------------------------------------------------------------
  // Case 2: INSERT INTO → rejected
  // -------------------------------------------------------------------------
  it("Case 2 — INSERT INTO x → rejected with error", () => {
    expect(() =>
      validateAndNormaliseSql("INSERT INTO v_leads (id) VALUES (1)"),
    ).toThrow(/no permitidas/i);
  });

  // -------------------------------------------------------------------------
  // Case 3: DROP TABLE → rejected
  // -------------------------------------------------------------------------
  it("Case 3 — DROP TABLE → rejected with error", () => {
    expect(() =>
      validateAndNormaliseSql("DROP TABLE v_leads"),
    ).toThrow(/no permitidas/i);
  });

  // -------------------------------------------------------------------------
  // Case 4: SELECT against a raw (non-v_*) table → rejected
  // -------------------------------------------------------------------------
  it("Case 4 — SELECT from raw table (no v_) → rejected", () => {
    expect(() =>
      validateAndNormaliseSql("SELECT * FROM users"),
    ).toThrow(/vista.*v_|v_.*vista/i);
  });

  // -------------------------------------------------------------------------
  // Case 5: SELECT v_x with no LIMIT → LIMIT 100 is injected
  // -------------------------------------------------------------------------
  it("Case 5 — SELECT v_x with no LIMIT → LIMIT 100 injected", () => {
    const result = validateAndNormaliseSql(
      "SELECT nombre FROM v_colonias ORDER BY nombre",
    );

    expect(result).toMatch(/LIMIT 100/i);
  });

  // -------------------------------------------------------------------------
  // Case 6: SELECT v_x with LIMIT 200 → capped to LIMIT 100
  // -------------------------------------------------------------------------
  it("Case 6 — SELECT v_x LIMIT 200 → capped to LIMIT 100", () => {
    const result = validateAndNormaliseSql(
      "SELECT nombre FROM v_colonias LIMIT 200",
    );

    // Must cap to 100, not allow 200.
    expect(result).toMatch(/LIMIT 100/i);
    expect(result).not.toMatch(/LIMIT 200/i);
  });

  // -------------------------------------------------------------------------
  // Case 7: SELECT v_x LIMIT 50 (within bound) → kept as-is (≤ 100)
  // -------------------------------------------------------------------------
  it("Case 7 — SELECT v_x LIMIT 50 → limit preserved", () => {
    const result = validateAndNormaliseSql(
      "SELECT nombre FROM v_colonias LIMIT 50",
    );

    expect(result).toMatch(/LIMIT 50/i);
    expect(result).not.toMatch(/LIMIT 100/i);
  });

  // -------------------------------------------------------------------------
  // Case 8: multi-statement (SELECT v_x; SELECT v_y) → rejected
  // -------------------------------------------------------------------------
  it("Case 8 — multi-statement SQL → rejected", () => {
    expect(() =>
      validateAndNormaliseSql(
        "SELECT id FROM v_leads; SELECT nombre FROM v_colonias",
      ),
    ).toThrow(/una sentencia/i);
  });

  // -------------------------------------------------------------------------
  // Case 9: comment-hiding DROP (/* comment */ DROP) → rejected after stripping
  // -------------------------------------------------------------------------
  it("Case 9 — DROP hidden in block comment suffix → rejected", () => {
    // The block comment is stripped, then DROP is evaluated.
    // e.g. "SELECT id FROM v_leads /* ok */ DROP TABLE users"
    // After stripping comments the SQL still has DROP in it.
    // Note: this is the raw text a malicious LLM might produce.
    expect(() =>
      validateAndNormaliseSql(
        "SELECT id FROM v_leads /* ok */ DROP TABLE leads",
      ),
    ).toThrow(/no permitidas/i);
  });

  // -------------------------------------------------------------------------
  // Case 10: UPDATE → rejected
  // -------------------------------------------------------------------------
  it("Case 10 — UPDATE → rejected with error", () => {
    expect(() =>
      validateAndNormaliseSql("UPDATE v_leads SET status = 'closed'"),
    ).toThrow(/no permitidas/i);
  });
});
