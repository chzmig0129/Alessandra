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
import { isUrgentCategory, isValidTipo, getTiposForCategoria } from "@/validation/taxonomy";
import { getTurnContext } from "@/lib/turn-context";

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
// Helper — resolve canonical IDs from RequestContext, overriding LLM args
// ---------------------------------------------------------------------------

function resolveCanonicalIds(
  input: { conversation_id?: string; user_id?: string },
  ctx?: { requestContext?: import("@mastra/core/request-context").RequestContext },
): { conversation_id: string | undefined; user_id: string | undefined } {
  // Priority 1: AsyncLocalStorage turn context (bulletproof, framework-agnostic)
  const turnCtx = getTurnContext();
  const alsConvId = turnCtx?.conversationId;
  const alsUserId = turnCtx?.userId;

  // Priority 2: Mastra RequestContext (belt-and-suspenders fallback)
  const rcConvId = ctx?.requestContext?.has("conversation_id")
    ? (ctx.requestContext.get("conversation_id") as string)
    : undefined;
  const rcUserId = ctx?.requestContext?.has("user_id")
    ? (ctx.requestContext.get("user_id") as string)
    : undefined;

  const canonicalConv = alsConvId ?? rcConvId;
  const canonicalUser = alsUserId ?? rcUserId;

  if (canonicalConv && input.conversation_id && input.conversation_id !== canonicalConv) {
    console.warn(
      "[reportes] conversation_id mismatch llm=" + input.conversation_id + " canonical=" + canonicalConv,
    );
  }
  if (canonicalUser && input.user_id && input.user_id !== canonicalUser) {
    console.warn(
      "[reportes] user_id mismatch llm=" + input.user_id + " canonical=" + canonicalUser,
    );
  }

  return {
    conversation_id: canonicalConv ?? input.conversation_id,
    user_id: canonicalUser ?? input.user_id,
  };
}

// ---------------------------------------------------------------------------
// Helper — resolve canonical attachments from RequestContext
// ---------------------------------------------------------------------------

function resolveAttachments(
  input: { image_url?: string; lat?: number; lng?: number },
  ctx?: { requestContext?: import("@mastra/core/request-context").RequestContext },
): { image_url: string | undefined; lat: number | undefined; lng: number | undefined } {
  // Priority 1: AsyncLocalStorage turn context
  const turnCtx = getTurnContext();
  const alsImageUrl = turnCtx?.attachments?.imageUrl;
  const alsLat = turnCtx?.attachments?.lat;
  const alsLng = turnCtx?.attachments?.lng;

  // Priority 2: Mastra RequestContext (fallback)
  const rcImageUrl = ctx?.requestContext?.has("image_url")
    ? (ctx.requestContext.get("image_url") as string)
    : undefined;
  const rcLat = ctx?.requestContext?.has("lat")
    ? (ctx.requestContext.get("lat") as number)
    : undefined;
  const rcLng = ctx?.requestContext?.has("lng")
    ? (ctx.requestContext.get("lng") as number)
    : undefined;

  return {
    image_url: alsImageUrl ?? rcImageUrl ?? input.image_url,
    lat: alsLat ?? rcLat ?? input.lat,
    lng: alsLng ?? rcLng ?? input.lng,
  };
}

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
    "(hasta fotos), PAUSA con el resumen y espera la confirmación del usuario en el siguiente mensaje.\n\n" +
    "USO DE PARAMS OPCIONALES: si el [CONTEXT] del system prompt incluye lat=X, lng=Y, image_url=Z, PÁSALOS al invocar esta tool. " +
    "La tool los usará para pre-llenar slots ubicacion y fotos automáticamente, ahorrando turnos.",
  inputSchema: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe("ID de la conversación activa (UUID)."),
    intencion: z
      .string()
      .min(1)
      .describe(
        "Frase corta del intent del usuario. Ej: \"reportar bache\", \"hay fuga de agua\", \"se cayó un árbol\".",
      ),
    lat: z
      .number()
      .optional()
      .describe(
        "OPCIONAL. Si el [CONTEXT] del system prompt incluye lat, pásalo aquí — pre-llena el slot ubicacion automáticamente.",
      ),
    lng: z
      .number()
      .optional()
      .describe(
        "OPCIONAL. Si el [CONTEXT] incluye lng, pásalo aquí — junto con lat pre-llena el slot ubicacion.",
      ),
    image_url: z
      .string()
      .optional()
      .describe(
        "OPCIONAL. Si el [CONTEXT] incluye image_url, pásalo aquí — pre-llena el slot fotos.",
      ),
    categoria_hint: z
      .string()
      .optional()
      .describe(
        "OPCIONAL. Hint inicial de categoría inferido del texto del usuario (ej: \"bache\", \"foco\", \"basura\").",
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
  execute: async ({ conversation_id, lat, lng, image_url, categoria_hint }, ctx) => {
    const { conversation_id: canonicalConvId } = resolveCanonicalIds({ conversation_id }, ctx);
    const resolvedConvId = canonicalConvId ?? conversation_id;

    // Resolve canonical attachment values from RequestContext (override LLM-passed args).
    const canonical = resolveAttachments({ image_url, lat, lng }, ctx);
    const effectiveImageUrl = canonical.image_url;
    const effectiveLat = canonical.lat;
    const effectiveLng = canonical.lng;

    const now = new Date();
    const initialSlots: Record<string, unknown> = {};
    if (categoria_hint) {
      initialSlots["categoria_hint"] = categoria_hint;
    }

    // Pre-llenar slots desde params opcionales del CONTEXT (usando valores canónicos)
    if (effectiveLat !== undefined && effectiveLng !== undefined && initialSlots["ubicacion"] === undefined) {
      initialSlots["ubicacion"] = { lat: effectiveLat, lng: effectiveLng };
    }
    if (effectiveImageUrl && initialSlots["fotos"] === undefined) {
      initialSlots["fotos"] = [effectiveImageUrl];
    }

    const result = await setFlowState(resolvedConvId, {
      domain: "reportes",
      step: "INICIO",
      slots: initialSlots,
      started_at: now.toISOString(),
      intent_snapshot: "reporte_ciudadano",
    });

    if (!result.ok) {
      return { ok: false as const, error: result.error };
    }

    const prompt =
      "FLUJO_RECIEN_INICIADO. Los slots están VACÍOS. DEBES invocar reporte_slot_llenar UNA VEZ por cada slot en este MISMO turn EN ORDEN: " +
      "categoria → tipo → descripcion → ubicacion → fotos. NO asumas slots de reportes anteriores en la conversación. " +
      "NO muestres resumen al usuario sin haber llenado los 5 slots primero. Después del 5to slot, muestra el resumen y espera confirmación del usuario.";

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
    "Cuando el usuario diga \"sí\"/\"confirmo\" después del resumen, llama directamente reporte_confirmar_y_crear({conversation_id, user_id}) " +
    "— NO necesitas slot_llenar(confirmado) antes. Esa tool es autosuficiente.",
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
  execute: async ({ conversation_id, slot, valor }, ctx) => {
    const { conversation_id: canonicalConvId } = resolveCanonicalIds({ conversation_id }, ctx);
    const resolvedConvId = canonicalConvId ?? conversation_id;

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

    // Override fotos/ubicacion from canonical attachments — the LLM cannot
    // overwrite an actual uploaded image with "sin_foto" or an empty value.
    // Priority: AsyncLocalStorage (turn context) > Mastra RequestContext
    if (slot === "fotos") {
      const alsImageUrl = getTurnContext()?.attachments?.imageUrl;
      const rcImageUrl = ctx?.requestContext?.has("image_url")
        ? (ctx.requestContext.get("image_url") as string)
        : undefined;
      const canonicalImageUrl = alsImageUrl ?? rcImageUrl;
      if (canonicalImageUrl) {
        if (decodedValor !== canonicalImageUrl && JSON.stringify(decodedValor) !== JSON.stringify([canonicalImageUrl])) {
          console.warn(
            "[reportes] slot fotos override: LLM passed '" +
              JSON.stringify(decodedValor) +
              "' but canonical image_url=" +
              canonicalImageUrl +
              " — forcing canonical value.",
          );
        }
        decodedValor = [canonicalImageUrl];
      }
    } else if (slot === "ubicacion") {
      const alsLat = getTurnContext()?.attachments?.lat;
      const alsLng = getTurnContext()?.attachments?.lng;
      const rcLat = ctx?.requestContext?.has("lat")
        ? (ctx.requestContext.get("lat") as number)
        : undefined;
      const rcLng = ctx?.requestContext?.has("lng")
        ? (ctx.requestContext.get("lng") as number)
        : undefined;
      const canonicalLat = alsLat ?? rcLat;
      const canonicalLng = alsLng ?? rcLng;
      if (canonicalLat !== undefined && canonicalLng !== undefined) {
        if (JSON.stringify(decodedValor) !== JSON.stringify({ lat: canonicalLat, lng: canonicalLng })) {
          console.warn(
            "[reportes] slot ubicacion override: LLM passed '" +
              JSON.stringify(decodedValor) +
              "' but canonical lat=" +
              canonicalLat +
              " lng=" +
              canonicalLng +
              " — forcing canonical value.",
          );
        }
        decodedValor = { lat: canonicalLat, lng: canonicalLng };
      }
    }

    // 1. Load current flow
    const flowResult = await getFlowState(resolvedConvId);
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
    const saveResult = await setFlowState(resolvedConvId, {
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
    "Analiza una imagen usando visión por computadora (Gemini). Devuelve descripción + categoría sugerida si aplica. " +
    "Úsala SIEMPRE que el usuario adjunte una imagen y quiera saber qué muestra (pregunte \"qué hay\", \"descríbela\", \"analízala\", \"identifícala\") — NO está limitada al flujo de reportes. " +
    "También úsala dentro del flujo de reportes para sugerir la categoría correcta. NO muta el flujo. " +
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
    "Crea el reporte ciudadano en BD. " +
    "SEMÁNTICA: invoca esta tool en cuanto el usuario haya dicho \"sí\"/\"confirmo\" después del resumen. " +
    "NO necesitas llamar slot_llenar(confirmado:true) antes — esta tool es autosuficiente y solo requiere que los slots " +
    "categoria, tipo, descripcion, ubicacion estén llenos. Si faltan, devolverá un error con instrucción explícita. " +
    "Devuelve folio (CUH-YYYYMMDD-NNN) y, si urgente, contactos de emergencia.",
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
  execute: async ({ conversation_id, user_id }, ctx) => {
    const { conversation_id: canonicalConvId, user_id: canonicalUserId } = resolveCanonicalIds({ conversation_id, user_id }, ctx);
    const resolvedConvId = canonicalConvId ?? conversation_id;
    const resolvedUserId = canonicalUserId ?? user_id;

    // 1. Load flow
    const flowResult = await getFlowState(resolvedConvId);
    if (!flowResult.ok) {
      return { ok: false as const, error: flowResult.error };
    }
    if (!flowResult.flow) {
      return { ok: false as const, error: "No hay un flujo de reporte activo." };
    }

    const flow = flowResult.flow;
    const slots = flow.slots;

    // 2. Extract required fields from slots
    const categoria = typeof slots["categoria"] === "string" ? slots["categoria"] : "";
    const tipo = typeof slots["tipo"] === "string" ? slots["tipo"] : "";
    const descripcion =
      typeof slots["descripcion"] === "string" ? slots["descripcion"] : "";
    const ubicacion = slots["ubicacion"];

    const missingSlots: string[] = [];
    if (!categoria) missingSlots.push("categoria");
    if (!tipo) missingSlots.push("tipo");
    if (!descripcion) missingSlots.push("descripcion");

    // Validar también ubicacion porque sin ella el RPC fallará
    const hasUbicacion = ubicacion !== null && typeof ubicacion === "object";
    if (!hasUbicacion) missingSlots.push("ubicacion");

    if (missingSlots.length > 0) {
      return {
        ok: false as const,
        error: `CRÍTICO: En este MISMO turn, ANTES de responderle al usuario, DEBES invocar reporte_slot_llenar para CADA slot faltante (${missingSlots.join(", ")}) leyendo los valores del HISTORIAL de la conversación, y LUEGO reintentar reporte_confirmar_y_crear. NO le pidas al usuario información que YA TE DIO en mensajes anteriores. NO digas que hubo un error técnico.`,
      };
    }

    // Cross-validate tipo against taxonomy — RPC has FK constraint that blows up
    // for invalid slugs.
    // Auto-correction: if tipo is invalid but the category has EXACTLY ONE valid tipo,
    // silently correct it and continue (no round-trip to LLM).
    if (tipo) {
      const tipoOk = await isValidTipo(categoria, tipo);
      if (!tipoOk) {
        const validos = await getTiposForCategoria(categoria);
        if (validos.length === 1) {
          // AUTO_CORRECCION: exactly one valid tipo — fix silently and continue.
          const correctedTipo = validos[0]!;
          console.info(
            `[reportes] auto-corrected tipo from "${tipo}" to "${correctedTipo}" for categoria="${categoria}"`,
          );
          // Persist corrected tipo back to flow state.
          const correctedSlots = { ...slots, tipo: correctedTipo };
          await setFlowState(resolvedConvId, { ...flow, slots: correctedSlots });
          // Use corrected value for rest of this execution.
          // (Re-assign via mutable local — we'll reference correctedTipo below.)
          slots["tipo"] = correctedTipo;
        } else {
          // 0 or 2+ valid tipos — let the LLM correct with explicit instruction.
          const lista = validos.length > 0 ? validos.join(", ") : "(ninguno registrado)";
          return {
            ok: false as const,
            error:
              `INSTRUCCIÓN_PARA_AGENTE: El tipo "${tipo}" no es válido para la categoría "${categoria}". ` +
              `Tipos válidos: ${lista}. INVOCA reporte_slot_llenar(slot:"tipo", valor:"<slug-correcto>") y ` +
              `INMEDIATAMENTE en este MISMO turn DEBES invocar reporte_confirmar_y_crear DESPUÉS de corregir el slot. ` +
              `NO muestres un nuevo resumen al usuario. NO pidas confirmación otra vez. El usuario YA confirmó.`,
          };
        }
      }
    }

    // Re-read tipo from slots in case auto-correction updated it.
    const efectiveTipo = typeof slots["tipo"] === "string" ? slots["tipo"] : tipo;

    // 3. Parse ubicacion
    let lat: number | null = null;
    let lng: number | null = null;
    let locationAddress: string | null = null;

    if (hasUbicacion) {
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
    const urgent = isUrgentCategory(categoria, efectiveTipo);
    const priority = urgent ? 0 : 2;

    // 6. Call RPC
    const rpcResult = await callCrearLead({
      conversation_id: resolvedConvId,
      user_id: resolvedUserId,
      category: categoria,
      report_type: efectiveTipo || null,
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
    await clearFlowState(resolvedConvId);

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
  execute: async ({ conversation_id }, ctx) => {
    const { conversation_id: canonicalConvId } = resolveCanonicalIds({ conversation_id }, ctx);
    const resolvedConvId = canonicalConvId ?? conversation_id;

    const result = await clearFlowState(resolvedConvId);
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
  execute: async ({ conversation_id, user_id, folio }, ctx) => {
    const { user_id: canonicalUserId } = resolveCanonicalIds({ conversation_id, user_id }, ctx);
    const resolvedUserId = canonicalUserId ?? user_id;

    let query = supabaseAdmin
      .from("leads")
      .select(
        "folio, user_id, category, report_type, status, priority, created_at, location_address, report",
      )
      .eq("user_id", resolvedUserId);

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
  execute: async ({ user_id, limit }, ctx) => {
    const { user_id: canonicalUserId } = resolveCanonicalIds({ user_id }, ctx);
    const resolvedUserId = canonicalUserId ?? user_id;
    const effectiveLimit = limit ?? 10;

    const { data, error } = await supabaseAdmin
      .from("leads")
      .select(
        "folio, user_id, category, report_type, status, priority, created_at, location_address, report",
      )
      .eq("user_id", resolvedUserId)
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
