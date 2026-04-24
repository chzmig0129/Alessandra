/**
 * Declarative slot configuration for each Reporte conversation state.
 * Each state declares which slots it needs, whether they are required,
 * a user-facing prompt, and an optional Zod validator.
 *
 * Slot key naming convention (Spanish, UI-facing):
 *   categoria  → maps to RPC p_category
 *   tipo       → maps to RPC p_report_type
 *   descripcion → maps to RPC p_report
 *   ubicacion  → composed: {lat, lng, location_address} or {direccion_libre, colonia}
 *   fotos      → maps to RPC p_media_urls (optional array of URLs)
 *   confirmado → boolean confirmation gate
 *
 * For RECOLECTANDO_UBICACION: the user may supply either
 *   { lat, lng }  OR  { direccion_libre, colonia }
 * This is modelled as a single virtual slot `ubicacion` whose validator
 * accepts either form.
 *
 * For categoria/tipo: validators are async and use taxonomy helpers
 * isValidCategoria / isValidTipo to validate slugs.
 * The LLM/agent is responsible for resolving free-text to slug BEFORE
 * calling reporte_slot_llenar — slots expect slugs, not free-form text.
 */

import { z } from "zod";
import type { ReporteState } from "./state-machine";
import { isValidCategoria, isValidTipo } from "@/validation/taxonomy";
import { LatLngSchema } from "@/validation/zod-schemas";

// ---------------------------------------------------------------------------
// Slot definition
// ---------------------------------------------------------------------------

export interface SlotDefinition {
  key: string;
  required: boolean;
  prompt: string;
  /**
   * Optional synchronous Zod validator.
   * Use `asyncValidator` for validators that require a DB/network call.
   */
  validator?: z.ZodType;
  /**
   * Optional async validator.
   * Returns a Zod parse result shape: { success: true, data } | { success: false, error }.
   */
  asyncValidator?: (value: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: string }>;
}

// ---------------------------------------------------------------------------
// State slot config
// ---------------------------------------------------------------------------

export interface StateSlotConfig {
  slots: SlotDefinition[];
}

// ---------------------------------------------------------------------------
// Ubicacion virtual slot validator
// Accepts: { lat: number, lng: number, location_address?: string }
//       OR { direccion_libre: string, colonia: string }
// ---------------------------------------------------------------------------

const UbicacionSchema = z.union([
  // Option A — coordinates (with optional reverse-geocoded address)
  LatLngSchema.extend({
    location_address: z.string().optional(),
  }),
  // Option B — free-form address
  z.object({
    direccion_libre: z.string().min(1),
    colonia: z.string().min(1),
  }),
]);

// ---------------------------------------------------------------------------
// SLOT_CONFIG
// ---------------------------------------------------------------------------

export const SLOT_CONFIG: Record<ReporteState, StateSlotConfig> = {
  INICIO: {
    slots: [],
  },

  IDENTIFICANDO_CATEGORIA: {
    slots: [
      {
        key: "categoria",
        required: true,
        prompt:
          "¿Qué tipo de problema quieres reportar? Por ejemplo: baches, basura, alumbrado, agua, parques, seguridad...",
        asyncValidator: async (value) => {
          const parsed = z.string().min(1).safeParse(value);
          if (!parsed.success) {
            return { success: false, error: "La categoría debe ser un texto no vacío." };
          }
          const valid = await isValidCategoria(parsed.data);
          if (!valid) {
            return {
              success: false,
              error: `Categoría no reconocida: "${parsed.data}". Proporciona un slug de categoría válido.`,
            };
          }
          return { success: true, data: parsed.data };
        },
      },
    ],
  },

  IDENTIFICANDO_TIPO: {
    slots: [
      {
        key: "tipo",
        required: true,
        prompt:
          "¿Puedes ser más específico sobre el tipo de problema? (Ej: bache-calle-secundaria, fuga-agua, foco-fundido...)",
        asyncValidator: async (value) => {
          const parsed = z.string().min(1).safeParse(value);
          if (!parsed.success) {
            return { success: false, error: "El tipo debe ser un texto no vacío." };
          }
          // Loose validation at slot level — full categoria+tipo cross-validation
          // happens in tools.ts before calling the RPC.
          return { success: true, data: parsed.data };
        },
      },
    ],
  },

  RECOLECTANDO_DESCRIPCION: {
    slots: [
      {
        key: "descripcion",
        required: true,
        prompt:
          "Describe el problema con más detalle: ¿desde cuándo existe?, ¿qué tan grave es?, cualquier dato adicional que consideres importante.",
        validator: z.string().min(10, "La descripción debe tener al menos 10 caracteres."),
      },
    ],
  },

  RECOLECTANDO_UBICACION: {
    slots: [
      {
        /**
         * Virtual slot that accepts either coordinate form or address form.
         * The orchestrator populates this key with whichever form the user
         * provides.  Downstream (tools.ts), the tools layer must destructure
         * the value and map it to the appropriate RPC parameters.
         */
        key: "ubicacion",
        required: true,
        prompt:
          "¿Dónde ocurre el problema? Puedes compartirme tu ubicación GPS o decirme la dirección y colonia.",
        validator: UbicacionSchema,
      },
    ],
  },

  RECOLECTANDO_FOTO: {
    slots: [
      {
        /**
         * Optional — user can skip with "no" / "sin foto".
         * key: "fotos" holds an array of photo URLs.
         * required: false means nextRequiredSlot() won't block here and
         * transitions() will advance once the state is entered.
         */
        key: "fotos",
        required: false,
        prompt:
          "¿Tienes una foto del problema? Puedes enviarla ahora o escribir \"sin foto\" para continuar.",
        validator: z
          .array(z.string().url("Cada foto debe ser una URL válida."))
          .or(z.literal("sin_foto")),
      },
    ],
  },

  CONFIRMACION: {
    slots: [
      {
        key: "confirmado",
        required: true,
        prompt:
          "¿Confirmas que todos los datos son correctos y deseas enviar el reporte? (Responde Sí / No)",
        validator: z.boolean(),
      },
    ],
  },

  GUARDADO: {
    slots: [],
  },

  CANCELADO: {
    slots: [],
  },
};
