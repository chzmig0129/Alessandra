/**
 * Declarative slot configuration for each Reporte conversation state.
 * Each state declares which slots it needs, whether they are required,
 * a user-facing prompt, and an optional Zod validator.
 *
 * For RECOLECTANDO_UBICACION: the user may supply either
 *   { lat, lng }  OR  { direccion_libre, colonia }
 * This is modelled as a single virtual slot `ubicacion` whose validator
 * accepts either form.
 *
 * For categoria/tipo: validators are async and pull loadReportTaxonomy() lazily.
 */

import { z } from "zod";
import type { ReporteState } from "./state-machine";
import { loadReportTaxonomy } from "@/validation/taxonomy";
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
// Accepts: { lat: number, lng: number }
//       OR { direccion_libre: string, colonia: string }
// ---------------------------------------------------------------------------

const UbicacionSchema = z.union([
  // Option A — coordinates
  LatLngSchema,
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
          const { categorias } = await loadReportTaxonomy();
          if (categorias.size > 0 && !categorias.has(parsed.data)) {
            return {
              success: false,
              error: `Categoría no reconocida: "${parsed.data}". Opciones válidas: ${[...categorias].join(", ")}.`,
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
          "¿Puedes ser más específico sobre el tipo de problema? (Ej: bache en calle secundaria, fuga de agua, foco fundido...)",
        asyncValidator: async (value) => {
          const parsed = z.string().min(1).safeParse(value);
          if (!parsed.success) {
            return { success: false, error: "El tipo debe ser un texto no vacío." };
          }
          // We need categoria in context, but since validators receive only
          // the slot value here, tipo is validated loosely unless the caller
          // provides context.  The tools layer does full categoria+tipo
          // cross-validation using isValidTipo().
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
         * provides.  Downstream (folio.ts), the tools layer must destructure
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
         * required: false means nextRequiredSlot() won't block here and
         * transitions() will advance once the state is entered.
         */
        key: "foto_url",
        required: false,
        prompt:
          "¿Tienes una foto del problema? Puedes enviarla ahora o escribir \"sin foto\" para continuar.",
        validator: z
          .string()
          .url("La foto debe ser una URL válida.")
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
