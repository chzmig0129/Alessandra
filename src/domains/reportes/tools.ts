/**
 * Mastra tools for the Reportes Ciudadanos domain.
 *
 * Exports 7 tools:
 *   1. reporte_iniciar           — starts a new report flow
 *   2. reporte_slot_llenar       — fills one slot and advances the FSM
 *   3. reporte_analizar_imagen   — vision analysis; never mutates flow
 *   4. reporte_confirmar_y_crear — creates the lead record on confirmation
 *   5. reporte_cancelar          — cancels and clears the flow
 *   6. reporte_consultar         — looks up one report by folio or user_id
 *   7. reporte_listar_mios       — lists recent reports for a user
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { supabaseAdmin } from "@/db/supabase-server";
import { getFlowState, setFlowState, clearFlowState } from "@/memory/flow-state";
import { transitions, nextRequiredSlot } from "./state-machine";
import type { ReporteState } from "./state-machine";
import { SLOT_CONFIG } from "./slots";
import { callCrearLead } from "./folio";
import { analyzeImage } from "@/tools/shared/vision";
import { lookupEmergencyContacts } from "@/tools/shared/emergency-contacts";
import { isUrgentCategory } from "@/validation/taxonomy";

// ---------------------------------------------------------------------------
// Helper — emergency-contact shape for output schema
// ---------------------------------------------------------------------------

const EmergencyContactSchema = z.object({
  id: z.number(),
  nombre: z.string(),
  telefono: z.string(),
  categoria: z.string().nullable(),
  descripcion: z.string().nullable(),
  activo: z.boolean(),
});

// ---------------------------------------------------------------------------
// 1. reporte_iniciar
// ---------------------------------------------------------------------------

export const reporteIniciar = createTool({
  id: "reporte_iniciar",
  description:
    "Inicia el flujo de un nuevo reporte ciudadano. " +
    "INVOCA esta tool en cuanto el usuario exprese intención de reportar " +
    "(\"quiero reportar\", \"hay un bache\", \"reportar fuga\", \"se cayó un árbol\"). " +
    "DESPUÉS de invocar esta tool, DEBES llenar todos los slots con reporte_slot_llenar en ORDEN: " +
    "categoria → tipo → descripcion → ubicacion → fotos → confirmado. " +
    "NO llames reporte_confirmar_y_crear sin haber pasado todos los slots primero. " +
    "FLUJO OBLIGATORIO: los 6 slots deben llenarse en ese orden antes de confirmar. " +
    "Recuerda: nunca completes el flujo entero en un solo turn. Después de llenar los primeros 5 slots " +
    "(hasta fotos), PAUSA con el resumen y espera la confirmación del usuario en el siguiente mensaje.",
  inputSchema: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe("ID de la conversación activa (UUID)."),
    categoria_hint: z
      .string()
      .optional()
      .describe(
        "Sugerencia de categoría ya detectada del mensaje inicial. " +
        "Ejemplos de strings válidos: 'bache', 'fuga de agua', 'alumbrado', 'árbol caído'. " +
        "Opcional — si no se detectó aún, omitir.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      next_prompt: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ conversation_id, categoria_hint }) => {
    const now = new Date();
    const slots: Record<string, unknown> = {};
    if (categoria_hint) {
      slots["categoria_hint"] = categoria_hint;
    }

    const result = await setFlowState(conversation_id, {
      domain: "reportes",
      step: "INICIO",
      slots,
      started_at: now.toISOString(),
      intent_snapshot: "reporte_ciudadano",
    });

    if (!result.ok) {
      return { ok: false as const, error: result.error };
    }

    const prompt =
      SLOT_CONFIG["IDENTIFICANDO_CATEGORIA"].slots[0]?.prompt ??
      "¿Qué problema quieres reportar?";

    return { ok: true as const, next_prompt: prompt };
  },
});

// ---------------------------------------------------------------------------
// 2. reporte_slot_llenar
// ---------------------------------------------------------------------------

export const reporteSlotLlenar = createTool({
  id: "reporte_slot_llenar",
  description:
    "Llena un slot del flujo activo de reporte. " +
    "FLUJO OBLIGATORIO: invoca esta tool una vez por cada slot en ORDEN: " +
    "categoria → tipo → descripcion → ubicacion → fotos → confirmado. " +
    "NO te saltes ningún paso. Si el flow ya tiene categoria_hint, IGUAL debes llamar " +
    "slot_llenar({slot:categoria, valor: <slug oficial>}) — el hint NO sustituye al slot.\n\n" +
    "CATEGORÍAS OFICIALES (slugs válidos para slot=categoria):\n" +
    "- alumbrado: focos, luminarias, iluminación pública\n" +
    "- animales: maltrato, extraviados, vacunación, esterilización\n" +
    "- arbolado: poda, derribo, retiro de tocón\n" +
    "- cultura, emergencias, hospedaje, monumentos, otro, parques, recomendaciones, recreativo, restaurantes, salud, transporte\n" +
    "- infraestructura: BACHES, fugas de agua, banquetas, calles\n" +
    "- limpia: basura, recolección\n\n" +
    "MAPEO COMÚN (texto del usuario → slug):\n" +
    "bache → categoria=infraestructura, tipo=infraestructura_bache\n" +
    "foco fundido / luminaria → categoria=alumbrado, tipo=alumbrado_luminaria\n" +
    "basura → categoria=limpia\n" +
    "fuga de agua → categoria=infraestructura\n" +
    "árbol caído / poda → categoria=arbolado\n" +
    "maltrato animal → categoria=animales\n\n" +
    "FORMATO DEL VALOR según slot:\n" +
    "- categoria, tipo, descripcion: string plano (ej: \"infraestructura\")\n" +
    "- ubicacion: JSON string. Si tienes coords del CONTEXT lat/lng, usa {\"lat\":19.44,\"lng\":-99.15}. Si dirección libre: {\"direccion_libre\":\"Av Reforma 100\",\"colonia\":\"Juárez\"}\n" +
    "- fotos: JSON string. Array de URLs [\"https://...\"] o el literal \"sin_foto\" si el usuario no envió imagen\n" +
    "- confirmado: el literal string \"true\" SOLO después de mostrar el resumen al usuario Y recibir \"sí\"/\"confirmo\" explícito\n\n" +
    "DOS TURNS — REGLA DE PAUSA OBLIGATORIA:\n" +
    "- Turn donde recolectas datos (foto, texto, coords del usuario): llena slots categoria, tipo, descripcion, ubicacion, fotos. " +
    "DESPUÉS escribe el resumen al usuario:\n" +
    "  Voy a registrar:\n" +
    "  - Categoría: <slug>\n" +
    "  - Tipo: <slug>\n" +
    "  - Descripción: <descripcion>\n" +
    "  - Ubicación: <coords o dirección>\n" +
    "  - Fotos: <sí/no>\n" +
    "  ¿Confirmas? Responde sí o confirmo.\n" +
    "  Y PARA. NO llenes confirmado:true en este turn. NO llames reporte_confirmar_y_crear.\n" +
    "- Turn donde el usuario dice sí/confirmo: SOLO entonces llamas slot_llenar(slot:\"confirmado\", valor:\"true\") " +
    "seguido de reporte_confirmar_y_crear, y redactas el mensaje con el folio.\n\n" +
    "REGLA ATÓMICA — slot \"confirmado\" + reporte_confirmar_y_crear son INSEPARABLES:\n" +
    "Cuando llames slot_llenar({slot:\"confirmado\", valor:\"true\"}), DEBES en el MISMO TURN, sin pausar ni redactar texto intermedio, " +
    "llamar IMMEDIATAMENTE después reporte_confirmar_y_crear({conversation_id, user_id}). " +
    "NO redactes nada al usuario entre ambas llamadas. NO esperes otro turn. " +
    "Solo después de obtener el folio (CUH-…) de reporte_confirmar_y_crear, redactas el mensaje final al usuario con el folio.\n\n" +
    "REGLAS DURAS:\n" +
    "- NUNCA llames reporte_confirmar_y_crear sin haber llenado confirmado:true primero.\n" +
    "- El error EL FLUJO NO ESTÁ EN ESTADO CONFIRMACION significa que te saltaste slots — vuelve a llenarlos en orden.",
  inputSchema: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe("ID de la conversación activa. Ejemplo: 'conv_abc123'."),
    slot: z
      .string()
      .min(1)
      .describe(
        "Clave del slot a llenar. Valores posibles: 'categoria' (ej: 'baches'), " +
        "'tipo' (ej: 'bache en calzada'), 'descripcion' (ej: 'Bache grande en Av. Reforma'), " +
        "'ubicacion' (JSON con lat/lng o direccion_libre), 'fotos' (JSON array de URLs o '\"sin_foto\"'), " +
        "'confirmado' ('true' o 'false').",
      ),
    valor: z
      .string()
      .describe(
        "Valor del slot como string. Para slots estructurados, pasa JSON.stringify del valor: " +
        "ubicacion → '{\"lat\":19.43,\"lng\":-99.13}' o '{\"direccion_libre\":\"Av X 100\",\"colonia\":\"Centro\"}'. " +
        "fotos → '[\"https://img.ejemplo.com/foto.jpg\"]' o '\"sin_foto\"'. " +
        "confirmado → 'true' o 'false'. " +
        "Otros (categoria, tipo, descripcion) → el string directo, ej: 'fuga de agua'.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      next_state: z.string(),
      next_prompt: z.string().optional(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ conversation_id, slot, valor }) => {
    // 0. Decode `valor`: structured slots (ubicacion / fotos / confirmado) come
    //    as JSON-encoded strings from the LLM; plain text slots stay as-is.
    let decodedValor: unknown = valor;
    if (slot === "ubicacion" || slot === "fotos" || slot === "confirmado") {
      try {
        decodedValor = JSON.parse(valor);
      } catch {
        // If JSON.parse fails for `confirmado`, accept "true"/"false" string forms.
        if (slot === "confirmado") {
          decodedValor = valor.toLowerCase() === "true";
        } else if (slot === "fotos" && valor === "sin_foto") {
          decodedValor = "sin_foto";
        } else {
          return {
            ok: false as const,
            error: `valor para slot '${slot}' debe ser JSON válido`,
          };
        }
      }
    }

    // 1. Load current flow
    const flowResult = await getFlowState(conversation_id);
    if (!flowResult.ok) {
      return { ok: false as const, error: flowResult.error };
    }
    if (!flowResult.flow) {
      return { ok: false as const, error: "No hay un flujo de reporte activo." };
    }

    const flow = flowResult.flow;
    const currentState = flow.step as ReporteState;
    const stateConfig = SLOT_CONFIG[currentState];

    // 2. Validate the slot value if a validator exists for this state's slot
    if (stateConfig) {
      const slotDef = stateConfig.slots.find((s) => s.key === slot);
      if (slotDef) {
        if (slotDef.asyncValidator) {
          const validation = await slotDef.asyncValidator(decodedValor);
          if (!validation.success) {
            return { ok: false as const, error: validation.error };
          }
        } else if (slotDef.validator) {
          const parsed = slotDef.validator.safeParse(decodedValor);
          if (!parsed.success) {
            return {
              ok: false as const,
              error: parsed.error.issues.map((i) => i.message).join("; "),
            };
          }
        }
      }
    }

    // 3. Mutate slots and persist
    const updatedSlots: Record<string, unknown> = { ...flow.slots, [slot]: decodedValor };

    // 4. Compute next state
    const nextState = transitions(currentState, updatedSlots);

    // 5. Persist updated flow
    const saveResult = await setFlowState(conversation_id, {
      ...flow,
      step: nextState,
      slots: updatedSlots,
    });

    if (!saveResult.ok) {
      return { ok: false as const, error: saveResult.error };
    }

    // 6. Determine next prompt (if any required slots remain)
    const nextSlotInfo = nextRequiredSlot(nextState, updatedSlots);
    const nextPrompt = nextSlotInfo?.prompt;

    return {
      ok: true as const,
      next_state: nextState,
      ...(nextPrompt !== undefined ? { next_prompt: nextPrompt } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// 3. reporte_analizar_imagen
// ---------------------------------------------------------------------------

export const reporteAnalizarImagen = createTool({
  id: "reporte_analizar_imagen",
  description:
    "Analiza una imagen usando visión por computadora y devuelve una descripción y categoría sugerida. " +
    "NO muta el flujo — solo propone. El orquestador decide si usar los resultados. " +
    "Úsala cuando el usuario adjunta una foto para ayudar a identificar la categoría del problema. " +
    "Ejemplo: el usuario envía foto de un bache → devuelve description='Bache profundo en calzada' y suggested_category='baches'.",
  inputSchema: z.object({
    image_url: z
      .string()
      .url()
      .describe(
        "URL pública de la imagen a analizar. " +
        "Ejemplo: 'https://storage.ejemplo.com/uploads/bache_av_reforma.jpg'.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      description: z.string(),
      suggested_category: z.string().optional(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ image_url }) => {
    try {
      const result = await analyzeImage(image_url);
      return {
        ok: true as const,
        description: result.description,
        ...(result.suggested_category !== undefined
          ? { suggested_category: result.suggested_category }
          : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});

// ---------------------------------------------------------------------------
// 4. reporte_confirmar_y_crear
// ---------------------------------------------------------------------------

export const reporteConfirmarYCrear = createTool({
  id: "reporte_confirmar_y_crear",
  description:
    "Crea el reporte ciudadano en BD luego de la confirmación. " +
    "PRECONDICIÓN ESTRICTA: el flow debe estar en estado CONFIRMACION y el slot confirmado=true. " +
    "Si recibes error EL FLUJO NO ESTÁ EN ESTADO CONFIRMACION, significa que faltan slots: " +
    "vuelve a reporte_slot_llenar y completa categoria, tipo, descripcion, ubicacion, fotos y confirmado " +
    "en FLUJO OBLIGATORIO (orden: categoria → tipo → descripcion → ubicacion → fotos → confirmado) ANTES de reintentar. " +
    "Devuelve folio (CUH-YYYYMMDD-NNN) y, si urgente, contactos de emergencia. " +
    "REGLA: solo invoca esta tool en el TURN POSTERIOR a recibir el sí/confirmo del usuario. " +
    "Si la estás invocando en el mismo turn donde recolectaste los datos, te SALTASTE la pausa de confirmación " +
    "— vuelve a redactar el resumen y espera la respuesta del usuario. " +
    "Si recibes el error con prefijo \"El flujo no está listo para crear\", significa que faltan slots — vuelve a slot_llenar para completarlos. " +
    "Si ya está en GUARDADO pero esta tool nunca devolvió folio, INVÓCALA igual — esta tool ahora es idempotente respecto a GUARDADO mientras el lead no exista.",
  inputSchema: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe("ID de la conversación activa. Ejemplo: 'conv_abc123'."),
    user_id: z
      .string()
      .min(1)
      .describe(
        "ID del usuario en la tabla public.users. " +
        "Ejemplo: 'usr_789xyz'. Requerido para asignar el reporte al usuario correcto.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      folio: z.string(),
      lead_id: z.string(),
      urgent_contacts: z.array(EmergencyContactSchema).optional(),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
  execute: async ({ conversation_id, user_id }) => {
    // 1. Load flow
    const flowResult = await getFlowState(conversation_id);
    if (!flowResult.ok) {
      return { ok: false as const, error: flowResult.error };
    }
    if (!flowResult.flow) {
      return { ok: false as const, error: "No hay un flujo de reporte activo." };
    }

    const flow = flowResult.flow;

    // Aceptar CONFIRMACION o GUARDADO. Si GUARDADO ya existe pero no hay lead en BD,
    // significa que slot_llenar(confirmado:true) avanzó la state machine pero el agente
    // no encadenó confirmar_y_crear. Rescatable.
    if (flow.step !== "CONFIRMACION" && flow.step !== "GUARDADO") {
      return {
        ok: false as const,
        error: `El flujo no está listo para crear (estado actual: ${flow.step}). Faltan slots por llenar.`,
      };
    }

    const slots = flow.slots;

    if (slots["confirmado"] !== true) {
      return {
        ok: false as const,
        error: "El usuario no ha confirmado el reporte (slot 'confirmado' no es true).",
      };
    }

    // 2. Extract required fields from slots
    const categoria = typeof slots["categoria"] === "string" ? slots["categoria"] : "";
    const tipo = typeof slots["tipo"] === "string" ? slots["tipo"] : "";
    const descripcion =
      typeof slots["descripcion"] === "string" ? slots["descripcion"] : "";

    if (!categoria || !tipo || !descripcion) {
      return {
        ok: false as const,
        error: "Faltan datos requeridos: categoria, tipo o descripcion.",
      };
    }

    // 3. Parse ubicacion
    let lat: number | null = null;
    let lng: number | null = null;
    let locationAddress: string | null = null;

    const ubicacion = slots["ubicacion"];
    if (ubicacion !== null && typeof ubicacion === "object") {
      const u = ubicacion as Record<string, unknown>;
      if (typeof u["lat"] === "number" && typeof u["lng"] === "number") {
        lat = u["lat"];
        lng = u["lng"];
        // Use reverse-geocoded address if available, otherwise build from free-form fields
        if (typeof u["location_address"] === "string") {
          locationAddress = u["location_address"];
        }
      } else if (typeof u["direccion_libre"] === "string") {
        // Free-form address: combine direccion_libre + colonia
        const colonia = typeof u["colonia"] === "string" ? `, ${u["colonia"]}` : "";
        locationAddress = `${u["direccion_libre"]}${colonia}`;
      }
    }

    // 4. Parse photos — slot key is 'fotos', an array of URLs or the literal "sin_foto"
    const rawFotos = slots["fotos"];
    let mediaUrls: string[] = [];
    if (Array.isArray(rawFotos)) {
      mediaUrls = rawFotos.filter((f): f is string => typeof f === "string");
    }
    // "sin_foto" scalar is simply ignored (empty array)

    // 5. Determine priority and routing area
    const urgent = isUrgentCategory(categoria, tipo);
    const priority = urgent ? 0 : 2;

    // 6. Call RPC
    const rpcResult = await callCrearLead({
      conversation_id,
      user_id,
      category: categoria,
      report_type: tipo || null,
      report: descripcion,
      lat,
      lng,
      location_address: locationAddress,
      media_urls: mediaUrls,
      priority,
    });

    if (!rpcResult.ok) {
      return { ok: false as const, error: rpcResult.error };
    }

    // 7. Clear flow on success
    await clearFlowState(conversation_id);

    // 8. Attach emergency contacts if urgent
    if (urgent) {
      const contacts = await lookupEmergencyContacts("urgente");
      return {
        ok: true as const,
        folio: rpcResult.folio,
        lead_id: rpcResult.lead_id,
        urgent_contacts: contacts,
      };
    }

    return {
      ok: true as const,
      folio: rpcResult.folio,
      lead_id: rpcResult.lead_id,
    };
  },
});

// ---------------------------------------------------------------------------
// 5. reporte_cancelar
// ---------------------------------------------------------------------------

export const reporteCancelar = createTool({
  id: "reporte_cancelar",
  description:
    "Cancela el flujo de reporte activo y libera el estado de la conversación. " +
    "Úsala cuando el usuario decide no continuar con el reporte. " +
    "Ejemplo: el usuario dice 'olvídalo', 'cancela', 'ya no quiero reportar'.",
  inputSchema: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe(
        "ID de la conversación activa cuyo flujo se cancelará. " +
        "Ejemplo: 'conv_abc123'.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  execute: async ({ conversation_id }) => {
    const result = await clearFlowState(conversation_id);
    if (!result.ok) {
      return { ok: false as const, error: result.error };
    }
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Lead row type for queries — real public.leads column names
// ---------------------------------------------------------------------------

interface LeadRow {
  folio: string;
  user_id: string;
  category: string;
  report_type: string | null;
  status: string;
  priority: number;
  created_at: string;
  location_address: string | null;
  report: string;
}

const LeadSchema = z.object({
  folio: z.string(),
  user_id: z.string(),
  category: z.string(),
  report_type: z.string().nullable(),
  status: z.string(),
  priority: z.number(),
  created_at: z.string(),
  location_address: z.string().nullable(),
  report: z.string(),
});

// ---------------------------------------------------------------------------
// 6. reporte_consultar
// ---------------------------------------------------------------------------

export const reporteConsultar = createTool({
  id: "reporte_consultar",
  description:
    "Consulta un reporte por folio o, si folio es omitido, el más reciente del usuario. " +
    "Si no se encuentra, responde literalmente \"No encontré ese reporte\" — NO sugieras canales externos. " +
    "Accede directamente a la tabla 'leads' para mostrar la descripción completa al usuario reportante. " +
    "Requiere user_id para privacidad — no devuelve reportes de otros usuarios.",
  inputSchema: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe("ID de la conversación activa (para contexto). Ejemplo: 'conv_abc123'."),
    user_id: z
      .string()
      .min(1)
      .describe("ID del usuario que consulta. Ejemplo: 'usr_789xyz'."),
    folio: z
      .string()
      .optional()
      .describe(
        "Folio del reporte a consultar. Ejemplo: 'CUH-20260101-001'. " +
        "Opcional — si se omite, se devuelve el reporte más reciente del usuario.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), lead: LeadSchema }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  execute: async ({ user_id, folio }) => {
    let query = supabaseAdmin
      .from("leads")
      .select(
        "folio, user_id, category, report_type, status, priority, created_at, location_address, report",
      )
      .eq("user_id", user_id);

    if (folio) {
      query = query.eq("folio", folio);
    } else {
      query = query.order("created_at", { ascending: false }).limit(1);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      return { ok: false as const, error: error.message };
    }

    if (!data) {
      return {
        ok: false as const,
        error:
          "REPORTE_NO_ENCONTRADO — responde literalmente: No encontré ese reporte a tu nombre. ¿Quieres revisar la lista de tus reportes recientes?",
      };
    }

    const parsed = LeadSchema.safeParse(data as LeadRow);
    if (!parsed.success) {
      return {
        ok: false as const,
        error: `Formato inesperado en respuesta: ${parsed.error.message}`,
      };
    }

    return { ok: true as const, lead: parsed.data };
  },
});

// ---------------------------------------------------------------------------
// 7. reporte_listar_mios
// ---------------------------------------------------------------------------

export const reporteListarMios = createTool({
  id: "reporte_listar_mios",
  description:
    "Lista los reportes más recientes del usuario autenticado. " +
    "Úsala cuando el usuario pregunta '¿qué reportes tengo?', 'mis reportes', '¿en qué estado van mis reportes?', etc. " +
    "SI la lista viene vacía (data:[]), responde literalmente \"No encontré reportes registrados a tu nombre. ¿Quieres abrir uno nuevo?\" " +
    "— NO inventes ni sugieras LOCATEL u otros recursos externos.",
  inputSchema: z.object({
    user_id: z
      .string()
      .min(1)
      .describe("ID del usuario que consulta. Ejemplo: 'usr_789xyz'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Número máximo de reportes a devolver. Default 10, máximo 50. " +
        "Ejemplo: 5 para mostrar solo los últimos 5 reportes.",
      ),
  }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: z.array(LeadSchema),
      note: z.string().optional(),
    }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  execute: async ({ user_id, limit }) => {
    const effectiveLimit = limit ?? 10;

    const { data, error } = await supabaseAdmin
      .from("leads")
      .select(
        "folio, user_id, category, report_type, status, priority, created_at, location_address, report",
      )
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(effectiveLimit);

    if (error) {
      return { ok: false as const, error: error.message };
    }

    const rows = (data ?? []) as LeadRow[];

    const leads = rows
      .map((row) => {
        const parsed = LeadSchema.safeParse(row);
        return parsed.success ? parsed.data : null;
      })
      .filter((lead): lead is z.infer<typeof LeadSchema> => lead !== null);

    if (leads.length === 0) {
      return {
        ok: true as const,
        data: [],
        note: "EMPTY_LIST_USER_HAS_NO_REPORTS — responde literalmente: No encontré reportes registrados a tu nombre. NO menciones LOCATEL, 911, ni otros recursos.",
      };
    }

    return { ok: true as const, data: leads };
  },
});
