// Real end-to-end smoke: hits orchestrator → router → Mastra agent → mundial tool → DB.
import { processTurn } from "@/agent/orchestrator";
import { getOrCreateUser } from "@/memory/session";

async function smoke(label: string, message: string, attachments?: any) {
  console.log(`\n━━━ ${label} ━━━`);
  const sessionId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userResult = await getOrCreateUser(`web:${sessionId}`);
  if (!userResult.ok) {
    console.error(`FAIL user create:`, userResult.error);
    return false;
  }
  const start = Date.now();
  const r = await processTurn({
    userMessage: message,
    userId: userResult.user.id,
    sessionId,
    attachments,
  });
  const ms = Date.now() - start;
  console.log(`Latency: ${ms}ms`);
  console.log(`Response: ${r.text.slice(0, 300)}${r.text.length > 300 ? "…" : ""}`);
  const toolCalls = (r.debug?.tool_calls ?? []) as any[];
  if (toolCalls.length) {
    console.log(
      `Tools called: ${toolCalls.map((t: any) => t.toolName || t.name).join(", ")}`,
    );
  } else {
    console.log(`Tools called: (none)`);
  }
  console.log("DEBUG keys:", Object.keys(r.debug ?? {}));
  console.log("DEBUG raw:", JSON.stringify(r.debug, null, 2).slice(0, 800));
  return true;
}

async function main() {
  // 1) Mundial — should hit mundial_partidos_buscar and mention Estadio Azteca
  await smoke("MUNDIAL: partido inaugural", "¿A qué hora juega México el partido de inauguración del Mundial 2026?");

  // 2) Off-topic — should refuse politely
  await smoke("OFF-TOPIC: clima", "¿Cómo está el clima mañana en CDMX?");

  // 3) Puntos Violeta — should hit puntos_violeta tool
  await smoke("VIOLETA: búsqueda", "¿Hay un Punto Violeta cerca de Roma Norte?");

  console.log("\n=== smoke complete ===");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
