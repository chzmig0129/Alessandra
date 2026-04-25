// Smoke test: dispara N preguntas al bot y captura las respuestas vía SSE.
// Uso: node scripts/smoke-test.mjs
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const AGENT = "alessandraAgent";

// Ubicación simulada cerca de Texcoco (la que usabas en pruebas). Puedes sobreescribir.
const TEX_LOC = { lat: 19.497337, lng: -98.888685, accuracy: 35 };
// Una segunda ubicación: centro Cuauhtémoc.
const CUH_LOC = { lat: 19.4324, lng: -99.1521, accuracy: 50 };

const cases = [
  // Mundial sin ubicación
  { q: "¿Cuándo juega México?", loc: null },
  { q: "Próximo partido de Argentina", loc: null },
  { q: "What stadiums are in Canada?", loc: null },
  { q: "Fan Fest en Guadalajara", loc: null },

  // Mundial con ubicación
  { q: "¿Cuál es el Fan Fest más cercano?", loc: TEX_LOC },
  { q: "Cómo llego al Estadio Azteca", loc: TEX_LOC },
  { q: "Estadio más cercano", loc: CUH_LOC },

  // Puntos violeta
  { q: "Punto violeta más cercano", loc: TEX_LOC },
  { q: "Cuántos puntos violeta hay en la Cuauhtémoc", loc: null },
  { q: "Puntos violeta abiertos 24 horas en la Roma", loc: null },

  // Mezcla / edge
  { q: "¿Bajo qué categoría se reporta un bache?", loc: null },
  { q: "Quién va a ganar el mundial", loc: null }, // pregunta sin respuesta posible
];

async function ask({ q, loc }) {
  const threadId = randomUUID();
  const body = { message: q, threadId, agent: AGENT };
  if (loc) body.userLocation = loc;
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) return `HTTP ${res.status}`;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let answer = "";
  let errored = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      let event = "message";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event: ")) event = l.slice(7).trim();
        else if (l.startsWith("data: ")) data += l.slice(6);
      }
      if (!data) continue;
      try {
        const p = JSON.parse(data);
        if (event === "token" && p.text) answer += p.text;
        else if (event === "error") errored = p.error || "error";
      } catch {}
    }
  }
  return errored ? `⚠️ ${errored}` : answer.trim();
}

const results = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  process.stdout.write(`[${i + 1}/${cases.length}] ${c.q}${c.loc ? " (📍)" : ""}\n`);
  const t0 = Date.now();
  let answer;
  try {
    answer = await ask(c);
  } catch (e) {
    answer = `⚠️ exception: ${e.message}`;
  }
  const ms = Date.now() - t0;
  results.push({ q: c.q, loc: !!c.loc, ms, answer });
  process.stdout.write(`  → ${ms}ms\n  ${answer.replace(/\n/g, "\n  ")}\n\n`);
}

const ok = results.filter((r) => !r.answer.startsWith("⚠️")).length;
console.log(`\n=== Resumen: ${ok}/${results.length} sin error ===`);
