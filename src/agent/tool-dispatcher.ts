/**
 * tool-dispatcher.ts — Transport-agnostic tool execution helper.
 *
 * Exposes a single function dispatchTool() that finds the correct tool
 * from the ALL_TOOLS registry, injects context via AsyncLocalStorage
 * (TurnContext) so tools behave identically to when they run inside
 * processTurn(), and returns a normalized result envelope.
 *
 * No transports (TwiML, HTTP, WebSocket) are assumed — callers handle
 * that layer themselves.
 */

import { RequestContext } from "@mastra/core/request-context";
import { runWithTurnContext } from "@/lib/turn-context";
import type { TurnContext } from "@/lib/turn-context";

import { emergencia_mujer_tool } from "@/domains/puntos-violeta/emergency";
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

// ---------------------------------------------------------------------------
// ALL_TOOLS registry — single source of truth, imported by orchestrator.ts
// and by HTTP voice endpoints. Add new tools here only.
// ---------------------------------------------------------------------------

export const ALL_TOOLS = {
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

export type ToolName = keyof typeof ALL_TOOLS;

// ---------------------------------------------------------------------------
// Context shape for callers
// ---------------------------------------------------------------------------

export interface DispatchContext {
  conversation_id: string;
  user_id: string;
  lat?: number;
  lng?: number;
  image_url?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// Return envelope
// ---------------------------------------------------------------------------

export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// dispatchTool
// ---------------------------------------------------------------------------

/**
 * Execute a single tool by name with the given arguments and context.
 *
 * The function:
 *   1. Validates that `tool` is a known key in ALL_TOOLS.
 *   2. Builds a Mastra RequestContext from the caller-supplied context so that
 *      tools that call ctx.requestContext?.get("conversation_id") still work.
 *   3. Wraps execution in runWithTurnContext() — the same AsyncLocalStorage
 *      mechanism used by processTurn() — so tools that call getTurnContext()
 *      (like the reportes tools) receive correct IDs.
 *   4. Returns { ok: true, result } on success or { ok: false, error } on
 *      any failure (unknown tool, validation error, thrown exception).
 */
export async function dispatchTool(args: {
  tool: string;
  args: unknown;
  context: DispatchContext;
}): Promise<DispatchResult> {
  const { tool: toolName, args: toolArgs, context } = args;

  // 1. Look up the tool
  if (!(toolName in ALL_TOOLS)) {
    return {
      ok: false,
      error: `Unknown tool: "${toolName}". Valid tools: ${Object.keys(ALL_TOOLS).join(", ")}`,
    };
  }

  const tool = ALL_TOOLS[toolName as ToolName];

  if (!tool.execute) {
    return {
      ok: false,
      error: `Tool "${toolName}" has no execute function.`,
    };
  }

  // 2. Build Mastra RequestContext
  const requestContext = new RequestContext();
  requestContext.set("conversation_id", context.conversation_id);
  requestContext.set("user_id", context.user_id);
  if (context.image_url) {
    requestContext.set("image_url", context.image_url);
  }
  if (context.lat !== undefined && context.lng !== undefined) {
    requestContext.set("lat", context.lat);
    requestContext.set("lng", context.lng);
  }

  // 3. Build TurnContext for AsyncLocalStorage
  const turnCtx: TurnContext = {
    conversationId: context.conversation_id,
    userId: context.user_id,
    attachments: {
      imageUrl: context.image_url,
      lat: context.lat,
      lng: context.lng,
    },
  };

  // 4. Execute inside runWithTurnContext
  try {
    const result = await runWithTurnContext(turnCtx, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tool.execute as any)(toolArgs, { requestContext }),
    );
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tool-dispatcher] "${toolName}" threw:`, err);
    return { ok: false, error: `Tool "${toolName}" execution failed: ${msg}` };
  }
}
