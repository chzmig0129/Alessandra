/**
 * Unit tests for callCrearLead (src/domains/reportes/folio.ts).
 *
 * All Supabase RPC calls are mocked — no real DB connection is made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @/db/supabase-server BEFORE importing the module under test.
//
// NOTE: vi.mock() is hoisted to the top of the file by vitest, so we MUST NOT
// reference variables declared in this file inside the factory function.
// Instead, we declare the mock function inline and retrieve it afterwards via
// vi.mocked() / the module itself.
// ---------------------------------------------------------------------------

vi.mock("@/db/supabase-server", () => {
  const rpc = vi.fn();
  return {
    supabaseAdmin: { rpc },
  };
});

// Import AFTER the mock declaration.
import { callCrearLead } from "@/domains/reportes/folio";
import type { CrearLeadArgs } from "@/domains/reportes/folio";
import { supabaseAdmin } from "@/db/supabase-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRpcOk(data: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabaseAdmin.rpc as any).mockResolvedValueOnce({ data, error: null });
}

function mockRpcErr(message: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabaseAdmin.rpc as any).mockResolvedValueOnce({ data: null, error: { message } as any });
}

const BASE_ARGS: CrearLeadArgs = {
  p_user_id: "uuid-test-user",
  p_categoria: "alumbrado",
  p_tipo: "foco_fundido",
  p_descripcion: "Foco fundido en la esquina",
  p_lat: 19.4326,
  p_lng: -99.1332,
  p_colonia: "Centro",
  p_image_urls: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callCrearLead", () => {
  beforeEach(() => {
    vi.mocked(supabaseAdmin.rpc).mockReset();
  });

  it("Test 1 — returns {ok:true, folio, lead_id} when RPC succeeds", async () => {
    mockRpcOk([{ folio: "CUH-20260424-001", lead_id: "uuid-x" }]);

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folio).toBe("CUH-20260424-001");
      expect(result.lead_id).toBe("uuid-x");
    }
  });

  it("Test 2 — folio matches CUH-YYYYMMDD-NNN regex (never constructed in TS)", async () => {
    mockRpcOk([{ folio: "CUH-20260101-042", lead_id: "uuid-y" }]);

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folio).toMatch(/^CUH-\d{8}-\d{3}$/);
    }
  });

  it("Test 3 — returns {ok:false, error} when RPC returns an error", async () => {
    mockRpcErr("Connection timeout");

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Connection timeout");
    }
  });

  it("Test 4 — returns {ok:false} when folio does not match CUH-YYYYMMDD-NNN", async () => {
    // Malformed folio — FolioSchema must reject it.
    mockRpcOk([{ folio: "FOLIO-INVALID-123", lead_id: "uuid-z" }]);

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("formato inesperado");
    }
  });

  it("Test 5 — returns {ok:false} when RPC returns an empty array", async () => {
    mockRpcOk([]);

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("crear_lead no devolvió");
    }
  });

  it("Test 6 — returns {ok:false} when lead_id is missing/empty", async () => {
    mockRpcOk([{ folio: "CUH-20260424-002", lead_id: "" }]);

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("lead_id recibido");
    }
  });

  it("Test 7 — uses default priority 2 when p_priority is omitted", async () => {
    mockRpcOk([{ folio: "CUH-20260424-003", lead_id: "uuid-defaults" }]);

    const result = await callCrearLead(BASE_ARGS);

    expect(result.ok).toBe(true);
    // Verify that rpc was called with p_priority: 2 (the default)
    expect(vi.mocked(supabaseAdmin.rpc)).toHaveBeenCalledWith(
      "crear_lead",
      expect.objectContaining({ p_priority: 2 }),
    );
  });
});
