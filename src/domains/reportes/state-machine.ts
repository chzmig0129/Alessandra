/**
 * State machine for the Reportes Ciudadanos conversation flow.
 * All functions here are pure (no side effects, no async).
 */

import { SLOT_CONFIG } from "./slots";

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

export type ReporteState =
  | "INICIO"
  | "IDENTIFICANDO_CATEGORIA"
  | "IDENTIFICANDO_TIPO"
  | "RECOLECTANDO_DESCRIPCION"
  | "RECOLECTANDO_UBICACION"
  | "RECOLECTANDO_FOTO"
  | "CONFIRMACION"
  | "GUARDADO"
  | "CANCELADO";

// ---------------------------------------------------------------------------
// Transition map — each state → next state once its slots are satisfied
// ---------------------------------------------------------------------------

const NEXT_STATE: Readonly<Record<ReporteState, ReporteState>> = {
  INICIO: "IDENTIFICANDO_CATEGORIA",
  IDENTIFICANDO_CATEGORIA: "IDENTIFICANDO_TIPO",
  IDENTIFICANDO_TIPO: "RECOLECTANDO_DESCRIPCION",
  RECOLECTANDO_DESCRIPCION: "RECOLECTANDO_UBICACION",
  RECOLECTANDO_UBICACION: "RECOLECTANDO_FOTO",
  RECOLECTANDO_FOTO: "CONFIRMACION",
  CONFIRMACION: "GUARDADO",
  // Terminal states — stay put
  GUARDADO: "GUARDADO",
  CANCELADO: "CANCELADO",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when all *required* slots for `state` are filled in `slots`.
 * For RECOLECTANDO_FOTO the foto slot is optional — the user may explicitly
 * skip it (by providing the string "sin foto" / "no") — so the state is
 * always considered fulfilled once reached (see note below).
 *
 * Note: RECOLECTANDO_FOTO has no required slots in SLOT_CONFIG; the only
 * slot (`foto_url`) is optional.  Therefore `areSlotsFilled` returns true
 * for that state unconditionally, which means `transitions` will advance
 * automatically.  The orchestrator must call `transitions` only when the
 * user has responded (either providing a URL or declining).
 */
function areSlotsFilled(state: ReporteState, slots: Record<string, unknown>): boolean {
  const config = SLOT_CONFIG[state];
  if (config === undefined) return true;

  return config.slots
    .filter((s) => s.required)
    .every((s) => {
      const value = slots[s.key];
      return value !== undefined && value !== null && value !== "";
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure transition function.
 * Given the current state and the accumulated slots, returns the next state.
 * If the current state's required slots are not yet filled, the same state
 * is returned (stay).
 * GUARDADO and CANCELADO are terminal — they always return themselves.
 */
export function transitions(
  state: ReporteState,
  slots: Record<string, unknown>,
): ReporteState {
  // Terminal states never leave
  if (state === "GUARDADO" || state === "CANCELADO") {
    return state;
  }

  if (areSlotsFilled(state, slots)) {
    return NEXT_STATE[state];
  }

  return state;
}

/**
 * Returns the first missing required slot for the given state, or null if
 * all required slots are already filled (meaning the state can advance).
 *
 * Used by the orchestrator to decide what question to ask the user next.
 */
export function nextRequiredSlot(
  state: ReporteState,
  slots: Record<string, unknown>,
): { slot: string; prompt: string } | null {
  const config = SLOT_CONFIG[state];
  if (config === undefined) return null;

  for (const slotDef of config.slots) {
    if (!slotDef.required) continue;
    const value = slots[slotDef.key];
    if (value === undefined || value === null || value === "") {
      return { slot: slotDef.key, prompt: slotDef.prompt };
    }
  }

  return null;
}
