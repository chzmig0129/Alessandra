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

import { classifyDomain } from "./router";
import { SYSTEM_PROMPT_BASE } from "./prompts/system";
import { promptForDomain } from "./prompts/domain-specific";
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
import { getFlowState } from "@/memory/flow-state";

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

import { env } from "@/env";
import type { AlessandraResponse } from "@/types";

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
  // Mundial (5)
  mundial_partidos_buscar: mundialPartidosBuscar,
  mundial_sede_info: mundialSedeInfo,
  mundial_fan_fest: mundialFanFest,
  mundial_partido_detalle: mundialPartidoDetalle,
  mundial_equipo_info: mundialEquipoInfo,
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
  // Shared analytics
  consulta_analitica_sql,
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
        lat: input.attachments?.lat,
        lng: input.attachments?.lng,
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
  const flow = flowResult.ok ? flowResult.flow : null;

  const recentMessages = await loadMessages(
    conversationId,
    env.MAX_CONTEXT_MESSAGES,
  );

  // ---- 4. Domain classification --------------------------------------------

  const cls = await classifyDomain(input.userMessage, flow);

  // ---- 5. System prompt ----------------------------------------------------

  const systemPrompt = SYSTEM_PROMPT_BASE + "\n\n" + promptForDomain(cls.domain);

  // Inject conversation/user context so tools that need them can receive the
  // values via the LLM-provided arguments.
  const contextLine =
    `\n\n[CONTEXT: conversation_id=${conversationId}, user_id=${input.userId}` +
    (input.attachments?.lat !== undefined
      ? `, lat=${input.attachments.lat}, lng=${input.attachments.lng}`
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agentResult: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentResult = await alessandraAgent.generateLegacy(messagesForAgent as any, {
      instructions: fullSystemPrompt,
      maxSteps: 5,
      temperature,
    });
  } catch (err) {
    console.error("[orchestrator] agent.generate failed:", err);
    return { text: "Tuve un problema técnico, intenta de nuevo." };
  }

  const rawText: string = typeof agentResult.text === "string" ? agentResult.text : "";
  // Mastra's GenerateTextResult exposes top-level toolCalls/toolResults only for
  // the LAST step. To get every tool invocation across multi-step runs, walk
  // `steps[]` (each step has its own toolCalls/toolResults arrays).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allSteps: any[] = Array.isArray(agentResult.steps) ? agentResult.steps : [];
  const toolCalls: unknown[] =
    allSteps.length > 0
      ? allSteps.flatMap((s) => (Array.isArray(s.toolCalls) ? s.toolCalls : []))
      : Array.isArray(agentResult.toolCalls)
        ? agentResult.toolCalls
        : [];
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

  let finalText = rawText;

  const citationResult = citationCheck(rawText, toolResults);
  if (!citationResult.ok) {
    // One retry with a stricter prompt
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryResult: any = await alessandraAgent.generateLegacy(
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
        },
      );

      const retryText: string =
        typeof retryResult.text === "string" ? retryResult.text : "";
      const retryCitation = citationCheck(retryText, toolResults);

      if (retryCitation.ok) {
        finalText = retryText;
      } else {
        // Both attempts failed citation check
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
    },
  };
}
