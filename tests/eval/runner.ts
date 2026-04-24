/**
 * runner.ts — Eval harness for Alessandra.
 *
 * Usage:  npm run eval
 *         (invoked via: tsx tests/eval/runner.ts)
 *
 * For each *.json file under tests/eval/cases/:
 *   - Parse the case array.
 *   - For each case run all turns sequentially against processTurn().
 *   - Validate deterministic expectations against the final turn's response.
 *   - If judge_rubric present, call judgeResponse and require avg >= 4.0.
 * Reports domain-level stats + global totals then exits with code:
 *   0  if deterministicPct >= 95 AND judgeAvg >= 4.0
 *   1  otherwise
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { processTurn } from "@/agent/orchestrator";
import { getOrCreateUser } from "@/memory/session";
import { judgeResponse } from "./judge";
import type { AlessandraResponse } from "@/types";

// ---------------------------------------------------------------------------
// Types mirroring the JSON case schema
// ---------------------------------------------------------------------------

interface TurnInput {
  user: string;
  attachments?: Record<string, unknown> | Array<Record<string, unknown>>;
}

interface Expect {
  /** Tool name that must appear in debug.tool_calls, or null to assert no tool was called */
  tool_called?: string | null;
  /** Partial key/value match against the matched tool call's input */
  input_contains?: Record<string, unknown>;
  /** Strings that must appear (case-insensitive) in the final response text */
  response_must_contain?: string[];
  /** Strings that must NOT appear (case-insensitive) in the final response text */
  response_must_not_contain?: string[];
  /** If present, run LLM-as-judge and require avg >= 4.0 */
  judge_rubric?: string;
}

interface EvalCase {
  id: string;
  description?: string;
  turns: TurnInput[];
  expect?: Expect;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-partial match: every key in `subset` must exist in `obj` with an equal
 * value (strict equality for scalars; recursive for objects).
 */
function deepPartialMatch(
  obj: Record<string, unknown>,
  subset: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(subset)) {
    const expected = subset[key];
    const actual = obj[key];
    if (
      expected !== null &&
      typeof expected === "object" &&
      actual !== null &&
      typeof actual === "object"
    ) {
      if (
        !deepPartialMatch(
          actual as Record<string, unknown>,
          expected as Record<string, unknown>,
        )
      ) {
        return false;
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Extract tool calls from the AlessandraResponse debug payload.
 * The orchestrator puts them in debug.tool_calls as the raw array from
 * agentResult.toolCalls — each element has at minimum a `toolName` field
 * (Mastra SDK) or a `name` field (AI SDK shapes vary).
 */
function extractToolCalls(
  response: AlessandraResponse,
): Array<{ name: string; input: Record<string, unknown> }> {
  const rawCalls = response.debug?.["tool_calls"];
  if (!Array.isArray(rawCalls)) return [];

  return rawCalls.map((tc: unknown) => {
    const call = tc as Record<string, unknown>;
    // Mastra uses toolName; AI SDK core uses name; normalise to name.
    const name =
      typeof call["toolName"] === "string"
        ? call["toolName"]
        : typeof call["name"] === "string"
          ? call["name"]
          : "";
    // args / input field also varies
    const input =
      (call["args"] as Record<string, unknown>) ??
      (call["input"] as Record<string, unknown>) ??
      {};
    return { name, input };
  });
}

/**
 * Normalise the attachments from a TurnInput to the shape expected by
 * processTurn's attachments parameter.
 *
 * Two formats in the JSON cases:
 *   - Object with lat/lng: { lat: number, lng: number }
 *   - Array with image url: [{ type: 'image', url: string }]
 */
function normaliseAttachments(
  raw: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
): { lat?: number; lng?: number; imageUrl?: string } | undefined {
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    // Pick first image entry if present
    const imageEntry = raw.find((a) => a["type"] === "image");
    if (imageEntry) {
      return { imageUrl: imageEntry["url"] as string };
    }
    return undefined;
  }

  // Object form
  const result: { lat?: number; lng?: number; imageUrl?: string } = {};
  if (typeof raw["lat"] === "number") result.lat = raw["lat"];
  if (typeof raw["lng"] === "number") result.lng = raw["lng"];
  if (typeof raw["imageUrl"] === "string") result.imageUrl = raw["imageUrl"];
  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Run a single eval case
// ---------------------------------------------------------------------------

interface CaseResult {
  id: string;
  pass: boolean;
  reason: string;
  judgeScores?: { factualidad: number; relevancia: number; tono: number };
}

async function runCase(evalCase: EvalCase): Promise<CaseResult> {
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);
  const evalPhone = `eval:${shortId}`;

  // Create a real user row so processTurn gets a valid userId UUID.
  const userResult = await getOrCreateUser(evalPhone);
  if (!userResult.ok) {
    return {
      id: evalCase.id,
      pass: false,
      reason: `getOrCreateUser failed: ${userResult.error}`,
    };
  }
  const userId = userResult.user.id;

  let lastResponse: AlessandraResponse | null = null;
  let lastUserMessage = "";

  // Run turns sequentially (multi-turn ordering matters)
  for (const turn of evalCase.turns) {
    lastUserMessage = turn.user;
    lastResponse = await processTurn({
      userMessage: turn.user,
      userId,
      sessionId,
      attachments: normaliseAttachments(turn.attachments),
    });
  }

  if (!lastResponse) {
    return { id: evalCase.id, pass: false, reason: "no turns executed" };
  }

  const expect = evalCase.expect ?? {};
  const responseText = lastResponse.text ?? "";

  // ---- Validate tool_called ------------------------------------------------
  const toolCalls = extractToolCalls(lastResponse);

  if ("tool_called" in expect) {
    if (expect.tool_called === null || expect.tool_called === undefined) {
      // Expect NO tool call
      if (toolCalls.length > 0) {
        const names = toolCalls.map((t) => t.name).join(", ");
        return {
          id: evalCase.id,
          pass: false,
          reason: `Expected no tool call but got: ${names}`,
        };
      }
    } else {
      // Expect a specific tool
      const matched = toolCalls.find((t) => t.name === expect.tool_called);
      if (!matched) {
        const names =
          toolCalls.length > 0
            ? toolCalls.map((t) => t.name).join(", ")
            : "(none)";
        return {
          id: evalCase.id,
          pass: false,
          reason: `Expected tool '${expect.tool_called}' not in [${names}]`,
        };
      }

      // ---- Validate input_contains against the matched tool call -----------
      if (expect.input_contains) {
        if (!deepPartialMatch(matched.input, expect.input_contains)) {
          return {
            id: evalCase.id,
            pass: false,
            reason:
              `Tool '${expect.tool_called}' input mismatch. ` +
              `Expected subset: ${JSON.stringify(expect.input_contains)}. ` +
              `Got: ${JSON.stringify(matched.input)}`,
          };
        }
      }
    }
  }

  // ---- Validate response_must_contain --------------------------------------
  if (expect.response_must_contain) {
    for (const needle of expect.response_must_contain) {
      if (!responseText.toLowerCase().includes(needle.toLowerCase())) {
        return {
          id: evalCase.id,
          pass: false,
          reason: `response_must_contain: "${needle}" not found in response`,
        };
      }
    }
  }

  // ---- Validate response_must_not_contain ----------------------------------
  if (expect.response_must_not_contain) {
    for (const needle of expect.response_must_not_contain) {
      if (responseText.toLowerCase().includes(needle.toLowerCase())) {
        return {
          id: evalCase.id,
          pass: false,
          reason: `response_must_not_contain: "${needle}" found in response`,
        };
      }
    }
  }

  // ---- Judge rubric --------------------------------------------------------
  let judgeScores:
    | { factualidad: number; relevancia: number; tono: number }
    | undefined;

  if (expect.judge_rubric) {
    const scores = await judgeResponse({
      userMessage: lastUserMessage,
      response: responseText,
      rubric: expect.judge_rubric,
    });

    judgeScores = {
      factualidad: scores.factualidad,
      relevancia: scores.relevancia,
      tono: scores.tono,
    };

    const avg =
      (scores.factualidad + scores.relevancia + scores.tono) / 3;

    if (avg < 4.0) {
      return {
        id: evalCase.id,
        pass: false,
        reason: `judge avg ${avg.toFixed(2)} < 4.0 — ${scores.justificacion}`,
        judgeScores,
      };
    }
  }

  return { id: evalCase.id, pass: true, reason: "all checks passed", judgeScores };
}

// ---------------------------------------------------------------------------
// Domain name from file path
// ---------------------------------------------------------------------------

function domainFromFile(filePath: string): string {
  return path.basename(filePath, ".json");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // runner.ts lives at tests/eval/runner.ts → cases/ is a sibling directory.
  const runnerDir = path.dirname(new URL(import.meta.url).pathname);
  const casesDirResolved = path.join(runnerDir, "cases");

  let entries: string[];
  try {
    entries = await fs.readdir(casesDirResolved);
  } catch (err) {
    process.stderr.write(`Failed to read cases dir ${casesDirResolved}: ${err}\n`);
    process.exit(1);
  }

  const jsonFiles = entries
    .filter((e) => e.endsWith(".json"))
    .map((e) => path.join(casesDirResolved, e))
    .sort();

  if (jsonFiles.length === 0) {
    process.stderr.write("No .json case files found in " + casesDirResolved + "\n");
    process.exit(1);
  }

  interface DomainStats {
    domain: string;
    pass: number;
    fail: number;
    judgeScoreSum: number;
    judgeScoreCount: number;
  }

  const allDomainStats: DomainStats[] = [];
  let totalPass = 0;
  let totalFail = 0;
  let totalJudgeSum = 0;
  let totalJudgeCount = 0;

  for (const filePath of jsonFiles) {
    const domain = domainFromFile(filePath);
    let cases: EvalCase[];

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      cases = JSON.parse(raw) as EvalCase[];
    } catch (err) {
      process.stderr.write(`[${domain}] Failed to parse ${filePath}: ${err}\n`);
      continue;
    }

    const stats: DomainStats = {
      domain,
      pass: 0,
      fail: 0,
      judgeScoreSum: 0,
      judgeScoreCount: 0,
    };

    for (const evalCase of cases) {
      let result: CaseResult;
      try {
        result = await runCase(evalCase);
      } catch (err) {
        process.stderr.write(`[${domain}/${evalCase.id}] ERROR: ${err}\n`);
        result = {
          id: evalCase.id,
          pass: false,
          reason: `unhandled exception: ${err}`,
        };
      }

      if (result.pass) {
        stats.pass++;
      } else {
        stats.fail++;
        process.stderr.write(
          `[${domain}/${evalCase.id}] FAIL: ${result.reason}\n`,
        );
      }

      if (result.judgeScores) {
        const avg =
          (result.judgeScores.factualidad +
            result.judgeScores.relevancia +
            result.judgeScores.tono) /
          3;
        stats.judgeScoreSum += avg;
        stats.judgeScoreCount++;
      }
    }

    allDomainStats.push(stats);
    totalPass += stats.pass;
    totalFail += stats.fail;
    totalJudgeSum += stats.judgeScoreSum;
    totalJudgeCount += stats.judgeScoreCount;
  }

  // ---------------------------------------------------------------------------
  // Print report
  // ---------------------------------------------------------------------------

  const totalCases = totalPass + totalFail;
  const deterministicPct =
    totalCases > 0 ? (totalPass / totalCases) * 100 : 0;
  const judgeAvg =
    totalJudgeCount > 0 ? totalJudgeSum / totalJudgeCount : 0;

  process.stdout.write("\n=== Eval Report ===\n");

  for (const stats of allDomainStats) {
    const domainTotal = stats.pass + stats.fail;
    const pct = domainTotal > 0 ? (stats.pass / domainTotal) * 100 : 0;
    let line = `${stats.domain}: ${stats.pass}/${domainTotal} (${pct.toFixed(1)}%)`;
    if (stats.judgeScoreCount > 0) {
      const domainJudgeAvg = stats.judgeScoreSum / stats.judgeScoreCount;
      line += `  [judge avg: ${domainJudgeAvg.toFixed(1)}/5]`;
    }
    process.stdout.write(line + "\n");
  }

  process.stdout.write(
    `\nTOTAL DETERMINISTIC: ${totalPass}/${totalCases} (${deterministicPct.toFixed(1)}%)\n`,
  );
  if (totalJudgeCount > 0) {
    process.stdout.write(`JUDGE AVG: ${judgeAvg.toFixed(1)}/5\n`);
  }

  const passed = deterministicPct >= 95 && judgeAvg >= 4.0;
  process.stdout.write(
    `\nResult: ${passed ? "PASS" : "FAIL"} ` +
      `(thresholds: det>=95% AND judge>=4.0)\n`,
  );

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[runner] fatal: ${err}\n`);
  process.exit(1);
});
