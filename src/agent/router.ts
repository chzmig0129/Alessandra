/**
 * Domain router for Alessandra.
 *
 * classifyDomain(text, flowSnapshot) resolves the domain for a user message
 * using a three-tier strategy:
 *
 *   1. Flow stickiness  — if an active (non-expired) flow exists, keep its
 *                         domain with high confidence (0.95).
 *   2. Heuristic        — regex-based scoring via scoreDomain().  If the
 *                         top score is >= DOMAIN_THRESHOLD (0.4), return it.
 *   3. Off-topic gate   — if the top score is < 0.15, declare fuera_alcance
 *                         without an LLM call.
 *   4. LLM fallback     — scores in [0.15, 0.4) are inconclusive; ask the
 *                         LLM (MODEL_ROUTER) to classify, capped at 1 call
 *                         per invocation, no retries.
 *
 * No DB writes.  No side effects beyond the single optional LLM call.
 */

import type { Domain } from "@/types";
import { type Flow, isFlowExpired } from "@/memory/flow-state";
import { scoreDomain, DOMAIN_THRESHOLD } from "@/guardrails/router-confidence";
import { getModel } from "./model-config";
import { generateObject } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  domain: Domain;
  confidence: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score below which a message is considered clearly off-topic. */
const OFF_TOPIC_THRESHOLD = 0.15;

/** Confidence assigned when LLM is used for the final classification. */
const LLM_CONFIDENCE = 0.6;

/** Fixed confidence for stickiness path. */
const STICKINESS_CONFIDENCE = 0.95;

// ---------------------------------------------------------------------------
// LLM schema
// ---------------------------------------------------------------------------

const domainSchema = z.object({
  domain: z.enum(["mundial", "puntos_violeta", "reportes", "fuera_alcance"]),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the domain of a user message.
 *
 * @param text          The raw user message.
 * @param flowSnapshot  Current active flow state, or null if none.
 * @returns             Resolved domain, confidence score, and human-readable reason.
 *
 * @example
 *   // Stickiness
 *   await classifyDomain("ok, continúa", activeReportesFlow);
 *   // → { domain: "reportes", confidence: 0.95, reason: "flow_state stickiness" }
 *
 * @example
 *   // Heuristic
 *   await classifyDomain("¿a qué hora juega México?", null);
 *   // → { domain: "mundial", confidence: 0.3, reason: "heuristic" }
 *
 * @example
 *   // Off-topic
 *   await classifyDomain("¿cuál es la receta de guacamole?", null);
 *   // → { domain: "fuera_alcance", confidence: 1, reason: "no domain matched" }
 */
export async function classifyDomain(
  text: string,
  flowSnapshot: Flow | null,
): Promise<ClassifyResult> {
  // ---- Tier 1: Flow stickiness -------------------------------------------
  if (flowSnapshot != null && !isFlowExpired(flowSnapshot)) {
    const stickyDomain = flowSnapshot.domain as Domain;
    return {
      domain: stickyDomain,
      confidence: STICKINESS_CONFIDENCE,
      reason: "flow_state stickiness",
    };
  }

  // ---- Tier 2 & 3: Heuristic ---------------------------------------------
  const scores = scoreDomain(text, flowSnapshot);

  // Find the domain with the highest heuristic score.
  type ScoredDomain = keyof typeof scores;
  let maxDomain: ScoredDomain = "mundial";
  let maxScore = -Infinity;

  for (const [d, s] of Object.entries(scores) as [ScoredDomain, number][]) {
    if (s > maxScore) {
      maxScore = s;
      maxDomain = d;
    }
  }

  // Tier 2: heuristic is conclusive.
  if (maxScore >= DOMAIN_THRESHOLD) {
    return {
      domain: maxDomain as Domain,
      confidence: maxScore,
      reason: "heuristic",
    };
  }

  // Tier 3: clearly off-topic — no LLM needed.
  if (maxScore < OFF_TOPIC_THRESHOLD) {
    return {
      domain: "fuera_alcance",
      confidence: 1 - maxScore,
      reason: "no domain matched",
    };
  }

  // ---- Tier 4: LLM fallback (one call, no retries) -----------------------
  const { object: result } = await generateObject({
    model: getModel("router"),
    schema: domainSchema,
    prompt: [
      "Classify the following user message into exactly one of these domains:",
      "  - mundial        (FIFA World Cup 2026, matches, stadiums, fan fest)",
      "  - puntos_violeta (women's safety, gender emergency, violeta network)",
      "  - reportes       (citizen reports: potholes, lighting, trash, leaks)",
      "  - fuera_alcance  (anything outside the above three domains)",
      "",
      `User message: "${text}"`,
      "",
      "Respond with the domain key and a one-sentence reason in the same language as the message.",
    ].join("\n"),
  });

  return {
    domain: result.domain as Domain,
    confidence: LLM_CONFIDENCE,
    reason: `llm:${result.reason}`,
  };
}
