/**
 * judge.ts — LLM-as-judge for Alessandra eval suite.
 *
 * Scores an assistant response on three axes (0-5 each):
 *   factualidad  — accuracy of facts relative to the user question
 *   relevancia   — how well the response addresses what was asked
 *   tono         — appropriateness of tone (helpful, empathetic, professional)
 *
 * Returns the three scores plus a free-text justification.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "@/agent/model-config";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const JudgeSchema = z.object({
  factualidad: z.number().int().min(0).max(5),
  relevancia: z.number().int().min(0).max(5),
  tono: z.number().int().min(0).max(5),
  justificacion: z.string(),
});

export type JudgeResult = z.infer<typeof JudgeSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface JudgeInput {
  userMessage: string;
  response: string;
  rubric?: string;
}

/**
 * Ask the main model to evaluate a single assistant response.
 *
 * @param input  The user message, assistant response, and optional rubric hint.
 * @returns      Per-criterion integer scores 0-5 plus a justification string.
 */
export async function judgeResponse(input: JudgeInput): Promise<JudgeResult> {
  const { userMessage, response, rubric } = input;

  const prompt =
    `Evalúa esta respuesta de un asistente ciudadano. ` +
    `RUBRIC: ${rubric ?? "general"}. ` +
    `USUARIO: "${userMessage}". ` +
    `RESPUESTA: "${response}". ` +
    `Califica en escala 0-5 cada criterio. SOLO JSON.`;

  const { object } = await generateObject({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: getModel("main") as any,
    schema: JudgeSchema,
    prompt,
  });

  return object;
}
