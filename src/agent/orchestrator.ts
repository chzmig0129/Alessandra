/**
 * orchestrator.ts — Core turn-processing pipeline for Alessandra.
 *
 * Exports a single public function:
 *   processTurn(input): Promise<AlessandraResponse>
 *
 * Pipeline per turn:
 *   1. Load / create active session.
 *   2. Pre-LLM guardrails: rate-limit → gender emergency (short-circuit) → jailbreak.
 *   3. Load flow state + recent messages.
 *   4. Classify domain (router, respects stickiness).
 *   5. Build system prompt = SYSTEM_PROMPT_BASE + domain-specific addendum.
 *   6. Run Mastra Agent with temperature 0 for puntos_violeta, 0.3 otherwise.
 *   7. Post-LLM citation check; one retry with tighter prompt on failure.
 *   8. Persist user + assistant messages; bump session TTL.
 *   9. Return AlessandraResponse with debug payload.
 */

import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { runWithTurnContext } from "@/lib/turn-context";
import type { TurnContext } from "@/lib/turn-context";
import { supabaseAdmin } from "@/db/supabase-server";

import { classifyDomain } from "./router";
import { SYSTEM_PROMPT_BASE } from "./prompts/system";
import { domainHint } from "./prompts/domain-specific";
import {
  genderEmergencyResponse,
  type Canalizacion,
} from "./prompts/safety-protocols";
import { getModel } from "./model-config";

import {
  getOrCreateActiveSession,
  bumpSessionTtl,
} from "@/memory/session";
import { loadMessages, appendMessage } from "@/memory/conversation";
import { getFlowState, setFlowState } from "@/memory/flow-state";
import type { Flow } from "@/memory/flow-state";

import {
  checkRateLimit,
  detectGenderEmergency,
  detectJailbreak,
} from "@/guardrails/pre-llm";
import { citationCheck } from "@/guardrails/post-llm";

import { emergencia_mujer_canalizar, emergencia_mujer_tool } from "@/domains/puntos-violeta/emergency";
import { puntosVioletaBuscar, puntosVioletaDetalle } from "@/domains/puntos-violeta/tools";
import {
  mundialPartidosBuscar,
  mundialSedeInfo,
  mundialFanFest,
  mundialPartidoDetalle,
  mundialEquipoInfo,
  mundialComoLlegar,
} from "@/domains/mundial/tools";
import {
  reporteIniciar,
  reporteSlotLlenar,
  reporteAnalizarImagen,
  reporteConfirmarYCrear,
  reporteCancelar,
  reporteConsultar,
  reporteListarMios,
} from "@/domains/reportes/tools";
import { consulta_analitica_sql } from "@/tools/shared/sql-sandbox";
import { knowledgeBuscar } from "@/tools/shared/knowledge";

import { env } from "@/env";
import type { AlessandraResponse } from "@/types";

// ---------------------------------------------------------------------------
// Language detection helper
// ---------------------------------------------------------------------------

function detectUserLanguage(text: string): "es" | "en" | "pt" | "fr" | "it" {
  const t = text.toLowerCase();

  // Markers EXCLUSIVOS por idioma — palabras que NO aparecen como substring de
  // ninguna palabra común en español. Usamos `\b...\b` correctamente en cada
  // alternativa (no solo al primer/último token del grupo) para evitar matches
  // dentro de "donde", "responde", "esconde" → "onde" (PT), o "come" (verbo es)
  // → "come" (IT), etc.
  const PT_RE = /\b(não|obrigad[oa]|olá|você|também|jogo|estádio|copa do mundo|portugu[eê]s|brasil|portugal)\b/g;
  const EN_RE = /\b(hello|hi|please|thank you|stadium|world cup|today|tomorrow|when|where|what|how|the|and|with|from|near|nearest)\b/g;
  const FR_RE = /\b(bonjour|merci|où|quand|comment|stade|coupe du monde|aujourd|français|france)\b/g;
  const IT_RE = /\b(ciao|grazie|dove|stadio|coppa del mondo|oggi|domani|italiano|italia)\b/g;

  // Marcadores fuertes — un solo match basta porque son inequívocos.
  const STRONG_PT = /\b(não|obrigad[oa]|olá|você|também)\b/;
  const STRONG_FR = /\b(bonjour|merci|aujourd|où)\b/;
  const STRONG_IT = /\b(ciao|grazie)\b/;

  if (STRONG_PT.test(t)) return "pt";
  if (STRONG_FR.test(t)) return "fr";
  if (STRONG_IT.test(t)) return "it";

  // Conteo de matches — necesitamos 2+ de las regex menos exclusivas para
  // declarar un idioma no-español. Mensajes cortos en español típicos no
  // disparan ningún match y caen al default 'es'.
  const ptCount = (t.match(PT_RE) ?? []).length;
  const enCount = (t.match(EN_RE) ?? []).length;
  const frCount = (t.match(FR_RE) ?? []).length;
  const itCount = (t.match(IT_RE) ?? []).length;

  const max = Math.max(ptCount, enCount, frCount, itCount);
  if (max < 2) return "es";

  if (ptCount === max) return "pt";
  if (enCount === max) return "en";
  if (frCount === max) return "fr";
  if (itCount === max) return "it";

  return "es";
}

// ---------------------------------------------------------------------------
// Static response templates
// ---------------------------------------------------------------------------

const RATE_LIMIT_RESPONSE =
  "Has enviado demasiados mensajes en poco tiempo. Por favor, espera un momento antes de intentarlo de nuevo.";

const JAILBREAK_RESPONSE =
  "No puedo seguir esas instrucciones. Soy Alessandra, asistente de la Alcaldía Cuauhtémoc, y seguiré operando normalmente.";

const CITATION_FAILURE_RESPONSE =
  "Lo siento, no pude generar una respuesta verificable con los datos disponibles. Por favor, reformula tu pregunta.";

const CITATION_RETRY_SUFFIX =
  "\n\nREWRITE INSTRUCTION: Reescribe tu respuesta usando ÚNICAMENTE datos de los resultados de tools. " +
  "No inventes teléfonos, horarios, direcciones ni folios. Si el dato no está en los resultados, omítelo.";

// ---------------------------------------------------------------------------
// All tools record — static, shared across turns.
// Tools that need conversation_id / user_id accept them in their input schema
// and receive the values injected by the LLM from context.
// ---------------------------------------------------------------------------

const ALL_TOOLS = {
  // Mundial (6)
  mundial_partidos_buscar: mundialPartidosBuscar,
  mundial_sede_info: mundialSedeInfo,
  mundial_fan_fest: mundialFanFest,
  mundial_partido_detalle: mundialPartidoDetalle,
  mundial_equipo_info: mundialEquipoInfo,
  mundial_como_llegar: mundialComoLlegar,
  // Puntos Violeta (2 + emergency)
  puntos_violeta_buscar: puntosVioletaBuscar,
  puntos_violeta_detalle: puntosVioletaDetalle,
  emergencia_mujer_canalizar: emergencia_mujer_tool,
  // Reportes (7)
  reporte_iniciar: reporteIniciar,
  reporte_slot_llenar: reporteSlotLlenar,
  reporte_analizar_imagen: reporteAnalizarImagen,
  reporte_confirmar_y_crear: reporteConfirmarYCrear,
  reporte_cancelar: reporteCancelar,
  reporte_consultar: reporteConsultar,
  reporte_listar_mios: reporteListarMios,
  // Shared analytics + knowledge base
  consulta_analitica_sql,
  knowledge_buscar: knowledgeBuscar,
} as const;

// ---------------------------------------------------------------------------
// Mastra Agent singleton — model resolved at construction time.
// ---------------------------------------------------------------------------

const alessandraAgent = new Agent({
  id: "alessandra",
  name: "Alessandra",
  // Instructions are overridden per-turn via the generate() call options.
  instructions: SYSTEM_PROMPT_BASE,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: getModel("main") as any,
  tools: ALL_TOOLS,
});

// ---------------------------------------------------------------------------
// Auto-fill helper — deterministic slot population from attachments
// ---------------------------------------------------------------------------

async function autoFillReportesSlots(
  conversationId: string,
  flow: Flow | null,
  attachments?: { lat?: number; lng?: number; imageUrl?: string },
): Promise<Flow | null> {
  if (!flow) return null;
  if (flow.domain !== "reportes") return flow;
  if (!attachments) return flow;

  const updatedSlots: Record<string, unknown> = { ...flow.slots };
  let changed = false;

  if (
    attachments.lat !== undefined &&
    attachments.lng !== undefined &&
    updatedSlots.ubicacion === undefined
  ) {
    updatedSlots.ubicacion = { lat: attachments.lat, lng: attachments.lng };
    changed = true;
  }

  if (attachments.imageUrl && updatedSlots.fotos === undefined) {
    updatedSlots.fotos = [attachments.imageUrl];
    changed = true;
  }

  if (!changed) return flow;

  const updatedFlow: Flow = { ...flow, slots: updatedSlots };
  const setResult = await setFlowState(conversationId, updatedFlow);
  if (!setResult.ok) {
    console.warn("[orchestrator] auto-fill setFlowState failed:", setResult.error);
    return flow;
  }
  console.info(
    `[orchestrator] auto-filled reportes slots: ${Object.keys(updatedSlots).filter((k) => flow.slots[k] === undefined).join(",")}`,
  );
  return updatedFlow;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ProcessTurnInput {
  userMessage: string;
  userId: string;
  sessionId?: string;
  attachments?: {
    imageUrl?: string;
    lat?: number;
    lng?: number;
  };
}

/**
 * Processes a single conversation turn end-to-end.
 *
 * @param input  User message plus contextual metadata.
 * @returns      Text response plus optional debug payload.
 */
export async function processTurn(
  input: ProcessTurnInput,
): Promise<AlessandraResponse> {
  const startedAt = Date.now();

  // ---- 1. Session -----------------------------------------------------------
  let session: Awaited<ReturnType<typeof getOrCreateActiveSession>>;
  try {
    session = await getOrCreateActiveSession(input.userId);
  } catch (err) {
    console.error("[orchestrator] getOrCreateActiveSession failed:", err);
    return { text: "No pude cargar la sesión." };
  }

  const conversationId = session.conversationId;

  // ---- 1b. Image carryover — persist latest uploaded image; recover if missing ----
  // Persist the latest uploaded image so subsequent turns within the same
  // conversation can re-use it even if the user doesn't re-attach.
  let effectiveAttachments = input.attachments;
  if (effectiveAttachments?.imageUrl) {
    await supabaseAdmin
      .from("conversations")
      .update({
        last_image_url: effectiveAttachments.imageUrl,
        last_image_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  } else {
    // No image in this turn — try to recover the most recent one from this
    // conversation if it's still fresh (15 min window).
    const { data: convRow } = await supabaseAdmin
      .from("conversations")
      .select("last_image_url, last_image_at")
      .eq("id", conversationId)
      .maybeSingle();
    const lastUrl = convRow?.last_image_url as string | null | undefined;
    const lastAt = convRow?.last_image_at as string | null | undefined;
    if (lastUrl && lastAt) {
      const ageMs = Date.now() - new Date(lastAt).getTime();
      if (ageMs < 15 * 60 * 1000) {
        effectiveAttachments = {
          ...(effectiveAttachments ?? {}),
          imageUrl: lastUrl,
        };
      }
    }
  }

  // ---- 2. Pre-LLM guardrails ------------------------------------------------

  // Rate limit
  const rlResult = await checkRateLimit(input.userId);
  if (!rlResult.ok) {
    return {
      text: RATE_LIMIT_RESPONSE,
      debug: { rate_limited: true, retry_after_sec: rlResult.retryAfterSec },
    };
  }

  // Gender emergency — short-circuit, no LLM
  if (detectGenderEmergency(input.userMessage)) {
    let emergencyText: string;
    try {
      const canalizacion = await emergencia_mujer_canalizar({
        lat: effectiveAttachments?.lat,
        lng: effectiveAttachments?.lng,
      });

      // Build Canalizacion shape expected by genderEmergencyResponse.
      // emergencia_mujer_canalizar returns telefonos_clave as string[] where each
      // entry is a display-ready label like "*765 LUNAS" or "55 5658-1111 LOCATEL".
      // genderEmergencyResponse expects Record<string,string> and renders as
      //   "• {value}: {key}" for each entry.
      // We treat each full string as both key and value to produce:
      //   "• *765 LUNAS: *765 LUNAS" which is readable enough.
      // If future format separates number/label, update the splitter below.
      const telefonosRecord: Record<string, string> = {};
      for (const entry of canalizacion.telefonos_clave) {
        telefonosRecord[entry] = entry;
      }

      const canalizacionFormatted: Canalizacion = {
        puntos_violeta_24_7: canalizacion.puntos_violeta_24_7.map((p) => ({
          nombre: p.nombre ?? "",
          direccion: p.direccion ?? "",
          telefono: p.telefono ?? undefined,
        })),
        contactos: canalizacion.contactos.map((c) => ({
          nombre: c.nombre,
          descripcion: c.descripcion ?? undefined,
        })),
        telefonos_clave: telefonosRecord,
      };

      emergencyText = genderEmergencyResponse(canalizacionFormatted, "es");
    } catch (err) {
      console.error("[orchestrator] emergencia_mujer_canalizar failed:", err);
      // Fallback — hardcoded safety message so the user never gets nothing
      emergencyText =
        "Estoy aquí contigo. Tu seguridad es lo primero.\n" +
        "Si estás en peligro inmediato, llama al 911.\n\n" +
        "Números clave:\n• *765 LUNAS\n• 911\n• 55 5658-1111 LOCATEL";
    }

    // Persist both messages for continuity
    await appendMessage(conversationId, {
      role: "user",
      content: input.userMessage,
      created_at: new Date().toISOString(),
    });
    await appendMessage(conversationId, {
      role: "assistant",
      content: emergencyText,
      created_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt,
    });

    return {
      text: emergencyText,
      debug: { short_circuit: "gender_emergency", latency_ms: Date.now() - startedAt },
    };
  }

  // Jailbreak
  if (detectJailbreak(input.userMessage)) {
    return {
      text: JAILBREAK_RESPONSE,
      debug: { short_circuit: "jailbreak" },
    };
  }

  // ---- 3. Load flow + recent messages ---------------------------------------

  const flowResult = await getFlowState(conversationId);
  let flow = flowResult.ok ? flowResult.flow : null;
  // Auto-fill determinístico de slots reportes desde attachments — evita que el LLM alucine los slots
  flow = await autoFillReportesSlots(conversationId, flow, effectiveAttachments);

  const recentMessages = await loadMessages(
    conversationId,
    env.MAX_CONTEXT_MESSAGES,
  );

  // ---- 3b. Guard against duplicate leads ------------------------------------
  // If flow is null (no active report) and the user sends a bare confirmation
  // ("si", "confirmo", etc.) right after an assistant message that announced a
  // freshly-created folio, do NOT restart the flow — acknowledge and stop.
  if (flow == null) {
    const isBareConfirm = /^\s*(s[íi]|confirmo|ok|sip)\.?\s*$/i.test(input.userMessage);
    if (isBareConfirm) {
      const lastAssistant = [...recentMessages].reverse().find((m) => m.role === "assistant");
      const folioMatch = lastAssistant?.content.match(/CUH-\d{8}-\d{3}/);
      if (folioMatch) {
        const cannedText = `Tu reporte ya fue registrado (folio ${folioMatch[0]}). ¿Necesitas reportar algo más o tienes otra consulta?`;
        await appendMessage(conversationId, {
          role: "user",
          content: input.userMessage,
          created_at: new Date().toISOString(),
        });
        await appendMessage(conversationId, {
          role: "assistant",
          content: cannedText,
          created_at: new Date().toISOString(),
          latency_ms: Date.now() - startedAt,
        });
        await bumpSessionTtl(conversationId);
        return {
          text: cannedText,
          debug: { short_circuit: "duplicate_confirm_blocked", folio: folioMatch[0] },
        };
      }
    }
  }

  // ---- 4. Domain classification --------------------------------------------

  let cls = await classifyDomain(input.userMessage, flow);

  // Image-describe bias: if the user attached an image and is asking about its
  // content but the router returned null / fuera_alcance, nudge domain to
  // 'reportes' at medium confidence so the LLM sees reporte_analizar_imagen in
  // its tool belt and uses it.  Does NOT override a strong domain signal.
  if (
    (cls.domain === "fuera_alcance" || cls.confidence < 0.5) &&
    effectiveAttachments?.imageUrl &&
    /describ|analiz|identific|qu[eé] hay|qu[eé] es esto|qu[eé] muestra/i.test(input.userMessage)
  ) {
    cls = { domain: "reportes", confidence: 0.5, reason: "image_describe_bias" };
  }

  // ---- 5. System prompt ----------------------------------------------------

  const detectedLang = detectUserLanguage(input.userMessage);
  const langDirective =
    "\n\n[OUTPUT LANGUAGE LOCK: " +
    detectedLang +
    " — Generate the ENTIRE response in this language. This overrides any other language hint. Names of places (Estadio Azteca, Alcaldía Cuauhtémoc) and raw data from tools (phones, addresses) stay literal.]";

  const systemPrompt = SYSTEM_PROMPT_BASE + domainHint(cls.domain, cls.confidence) + langDirective;

  // Inject conversation/user context so tools that need them can receive the
  // values via the LLM-provided arguments.
  const contextLine =
    `\n\n[CONTEXT: conversation_id=${conversationId}, user_id=${input.userId}` +
    (effectiveAttachments?.lat !== undefined
      ? `, lat=${effectiveAttachments.lat}, lng=${effectiveAttachments.lng}`
      : "") +
    (effectiveAttachments?.imageUrl
      ? `, image_url=${effectiveAttachments.imageUrl}`
      : "") +
    "]";

  const fullSystemPrompt = systemPrompt + contextLine;

  // ---- 6. Build messages list ----------------------------------------------

  type CoreMsg = { role: "user" | "assistant" | "system"; content: string };

  const messagesForAgent: CoreMsg[] = [
    ...recentMessages.map(
      (m): CoreMsg => ({
        role: m.role === "tool" ? "assistant" : (m.role as "user" | "assistant"),
        content: m.content,
      }),
    ),
    { role: "user", content: input.userMessage },
  ];

  // ---- 7. Run agent --------------------------------------------------------

  const temperature = cls.domain === "puntos_violeta" ? 0 : 0.3;

  // Build canonical RequestContext so reportes tools can override any LLM-hallucinated IDs.
  const requestContext = new RequestContext();
  requestContext.set("conversation_id", conversationId);
  requestContext.set("user_id", input.userId);
  // Inject attachment data so tools can override LLM-passed image_url / lat / lng.
  if (effectiveAttachments?.imageUrl) {
    requestContext.set("image_url", effectiveAttachments.imageUrl);
  }
  if (effectiveAttachments?.lat !== undefined && effectiveAttachments?.lng !== undefined) {
    requestContext.set("lat", effectiveAttachments.lat);
    requestContext.set("lng", effectiveAttachments.lng);
  }

  // Build AsyncLocalStorage turn context — bulletproof fallback for tools that
  // cannot reliably read Mastra's requestContext in generateLegacy + maxSteps flows.
  const turnCtx: TurnContext = {
    conversationId,
    userId: input.userId,
    attachments: effectiveAttachments,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agentResult: any;
  try {
    agentResult = await runWithTurnContext(turnCtx, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      alessandraAgent.generateLegacy(messagesForAgent as any, {
        instructions: fullSystemPrompt,
        maxSteps: 15,
        temperature,
        requestContext,
      }),
    );
  } catch (err) {
    console.error("[orchestrator] agent.generate failed:", err);
    return { text: "Tuve un problema técnico, intenta de nuevo." };
  }

  // Re-cargar flow porque reporte_iniciar pudo haberlo creado durante el agent run
  try {
    const postRunFlowResult = await getFlowState(conversationId);
    if (postRunFlowResult.ok) {
      await autoFillReportesSlots(conversationId, postRunFlowResult.flow, effectiveAttachments);
    }
  } catch (err) {
    console.warn("[orchestrator] post-run auto-fill failed:", err);
  }

  const topLevelText: string = typeof agentResult.text === "string" ? agentResult.text : "";
  // Mastra's GenerateTextResult exposes top-level toolCalls/toolResults only for
  // the LAST step. To get every tool invocation across multi-step runs, walk
  // `steps[]` (each step has its own toolCalls/toolResults arrays).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allSteps: any[] = Array.isArray(agentResult.steps) ? agentResult.steps : [];

  // Mastra a veces deja .text vacío cuando el run terminó por maxSteps o por un
  // tool call final sin follow-up. Buscar el último step con texto no vacío.
  const stepTexts: string[] = allSteps
    .map((s) => (typeof s?.text === "string" ? s.text.trim() : ""))
    .filter((t) => t.length > 0);
  const lastStepText: string = stepTexts.length > 0 ? stepTexts[stepTexts.length - 1] ?? "" : "";

  const toolCalls: unknown[] =
    allSteps.length > 0
      ? allSteps.flatMap((s) => (Array.isArray(s.toolCalls) ? s.toolCalls : []))
      : Array.isArray(agentResult.toolCalls)
        ? agentResult.toolCalls
        : [];

  let rawText = topLevelText.trim().length > 0 ? topLevelText : lastStepText;

  if (rawText.trim().length === 0) {
    console.warn(
      "[orchestrator] empty rawText — agentResult shape:",
      JSON.stringify({
        hasTopLevelText: typeof agentResult.text === "string",
        topLevelTextLen: (agentResult.text ?? "").length,
        stepsCount: allSteps.length,
        stepsWithText: stepTexts.length,
        finishReason: agentResult.finishReason,
        toolCallsCount: toolCalls.length,
      }),
    );
    rawText =
      "Estoy procesando tu consulta pero no pude redactar la respuesta. ¿Puedes repetir la pregunta con otras palabras?";
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage: any = agentResult.usage ?? null;

  // ---- 8. Post-LLM citation check with one retry ---------------------------

  // Collect tool outputs across all steps for citation verification.
  const toolResults: unknown[] =
    allSteps.length > 0
      ? allSteps.flatMap((s) => (Array.isArray(s.toolResults) ? s.toolResults : []))
      : Array.isArray(agentResult.toolResults)
        ? agentResult.toolResults
        : [];

  // Salvaguarda determinística: si effectiveAttachments.imageUrl está seteado y un lead se
  // creó exitosamente en este turn pero su media_urls quedó vacío (porque el LLM
  // pasó 'sin_foto' y el override en slot_llenar no se propagó), patchearlo en BD
  // directamente. Idempotente — si ya tiene media_urls, no hace nada.
  if (effectiveAttachments?.imageUrl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const successfulCreate = toolResults.find((tr: any) =>
      tr?.toolName === "reporte_confirmar_y_crear" &&
      tr?.result?.ok === true &&
      typeof tr?.result?.lead_id === "string",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    const leadId: string | undefined = successfulCreate?.result?.lead_id;
    if (leadId) {
      try {
        const { data: leadRow } = await supabaseAdmin
          .from("leads")
          .select("media_urls")
          .eq("id", leadId)
          .single();
        const currentUrls = (leadRow?.media_urls as string[] | null) ?? [];
        if (currentUrls.length === 0) {
          await supabaseAdmin
            .from("leads")
            .update({ media_urls: [effectiveAttachments.imageUrl] })
            .eq("id", leadId);
          console.info("[orchestrator] post-create media_urls patch applied lead_id=" + leadId);
        }
      } catch (err) {
        console.warn("[orchestrator] post-create media_urls patch failed:", err);
      }
    }
  }

  let finalText = rawText;

  // Citation check es safety-critical para puntos_violeta (teléfonos/direcciones literales)
  // y reportes (folios exactos). Para mundial, los datos son temporales/contextuales y
  // el paraphrasing natural del LLM (horas, fechas) produce falsos positivos que rompen
  // respuestas básicas. Skip selectivo por dominio.
  const skipCitationCheck = cls.domain === "mundial" || cls.domain === "fuera_alcance" || cls.domain === null;

  const citationResult = skipCitationCheck
    ? { ok: true, missing: [] as string[], warnings: [] as string[] }
    : citationCheck(rawText, toolResults);

  if (!citationResult.ok) {
    console.warn(
      `[orchestrator] citationCheck failed domain=${cls.domain} missing=${JSON.stringify(citationResult.missing)} rawTextPreview=${JSON.stringify(rawText.slice(0, 200))}`,
    );
    // One retry with a stricter prompt
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryResult: any = await runWithTurnContext(turnCtx, () =>
        alessandraAgent.generateLegacy(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [
            ...messagesForAgent,
            { role: "assistant" as const, content: rawText },
            { role: "user" as const, content: CITATION_RETRY_SUFFIX },
          ] as any,
          {
            instructions: fullSystemPrompt,
            maxSteps: 1,
            temperature,
            requestContext,
          },
        ),
      );

      const retryText: string =
        typeof retryResult.text === "string" ? retryResult.text : "";
      const retryCitation = citationCheck(retryText, toolResults);

      if (retryCitation.ok && retryText.trim().length > 0) {
        finalText = retryText;
      } else {
        // Both attempts failed citation check (or retryText was empty)
        finalText = CITATION_FAILURE_RESPONSE;
      }
    } catch (retryErr) {
      console.error("[orchestrator] citation retry failed:", retryErr);
      finalText = CITATION_FAILURE_RESPONSE;
    }
  }

  // ---- 9. Persist messages + bump TTL --------------------------------------

  await appendMessage(conversationId, {
    role: "user",
    content: input.userMessage,
    created_at: new Date().toISOString(),
  });

  await appendMessage(conversationId, {
    role: "assistant",
    content: finalText,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    tokens_in: usage?.inputTokens ?? undefined,
    tokens_out: usage?.outputTokens ?? undefined,
    latency_ms: Date.now() - startedAt,
    created_at: new Date().toISOString(),
  });

  await bumpSessionTtl(conversationId);

  // ---- 10. Return ----------------------------------------------------------

  const latencyMs = Date.now() - startedAt;

  if (!finalText || finalText.trim().length === 0) {
    console.warn("[orchestrator] finalText empty at return — falling back to CITATION_FAILURE_RESPONSE");
    finalText = CITATION_FAILURE_RESPONSE;
  }

  // ---- Structured turn logging ---------------------------------------------
  {
    const uid8 = input.userId.slice(0, 8);
    const cid8 = conversationId.slice(0, 8);
    const msgPreview = input.userMessage.slice(0, 80);
    console.info(`[turn] user=${uid8} conv=${cid8} msg="${msgPreview}"`);
    console.info(`[turn]   classify: domain=${cls.domain} conf=${cls.confidence} reason=${cls.reason}`);

    // Build a map from toolCallId → toolResult for pairing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultById = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultsByIndex: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const tr of toolResults as any[]) {
      if (tr && typeof tr.toolCallId === "string") {
        resultById.set(tr.toolCallId, tr);
      }
      resultsByIndex.push(tr);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (toolCalls as any[]).forEach((tc: any, idx: number) => {
      const name: string = tc?.toolName ?? tc?.name ?? "unknown";
      const args = tc?.args ?? tc?.input ?? {};
      const argsJson = JSON.stringify(args).slice(0, 200);

      // Pair with result: prefer by toolCallId, fall back to index
      const tr =
        (tc?.toolCallId && resultById.has(tc.toolCallId)
          ? resultById.get(tc.toolCallId)
          : resultsByIndex[idx]) ?? null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = tr?.result ?? tr;
      let resultSummary: string;
      if (result !== null && result !== undefined && typeof result === "object" && "ok" in result) {
        if (result.ok === true) {
          if (Array.isArray(result.rows)) {
            resultSummary = `ok ${result.rows.length} rows`;
          } else if (Array.isArray(result.data)) {
            resultSummary = `ok ${result.data.length} rows`;
          } else {
            resultSummary = "ok";
          }
        } else {
          const errMsg: string = typeof result.error === "string" ? result.error : "unknown";
          resultSummary = `error: ${errMsg.slice(0, 100)}`;
        }
      } else {
        resultSummary = "returned";
      }

      console.info(`[turn]   tool_call ${name}(${argsJson}) → ${resultSummary}`);
    });

    const finalPreview = finalText.slice(0, 120);
    const tokensIn = usage?.inputTokens ?? 0;
    const tokensOut = usage?.outputTokens ?? 0;
    console.info(`[turn]   final: "${finalPreview}" latency=${latencyMs}ms tokens=${tokensIn}/${tokensOut}`);
  }

  return {
    text: finalText,
    debug: {
      tool_calls: toolCalls,
      tokens: usage
        ? {
            input: usage.inputTokens,
            output: usage.outputTokens,
            total: usage.totalTokens,
          }
        : null,
      latency_ms: latencyMs,
      classification: cls,
      detected_lang: detectedLang,
    },
  };
}
