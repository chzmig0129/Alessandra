import postgres from "postgres";
import "dotenv/config";

// Sincronización uni-direccional: API-Sports → nuestra DB.
// - Actualiza marcador y estado de partidos con api_fixture_id != NULL y estado != 'finalizado'.
// - Refresca eventos_partido (DELETE + re-INSERT) por partido.
// - Refresca alineaciones (DELETE + re-INSERT) por partido.
// - Llamadas: 3 por partido por tick (fixture, events, lineups).

const API = "https://v3.football.api-sports.io";
const KEY = process.env.API_SPORTS_KEY;

function mapStatus(short: string): string {
  if (["TBD", "NS"].includes(short)) return "programado";
  if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT"].includes(short)) return "en_vivo";
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "finalizado";
  if (["PST", "CANC", "ABD", "SUSP"].includes(short)) return "suspendido";
  return "en_vivo"; // fallback conservador
}

// Devuelve el tipo de evento si cae dentro del enum válido en DB, o null si hay que saltarlo.
function mapEventType(type: string, detail: string): string | null {
  const t = (type || "").toLowerCase();
  const d = (detail || "").toLowerCase();
  if (t === "goal") {
    if (d.includes("own")) return "autogol";
    if (d.includes("penalty") && d.includes("miss")) return null; // penal fallado no tiene tipo válido
    if (d.includes("penalty")) return "gol_penal";
    return "gol";
  }
  if (t === "card") {
    if (d.includes("yellow")) return "amarilla";
    if (d.includes("red")) return "roja";
    return null;
  }
  if (t === "subst") return "cambio";
  if (t === "var") return "var";
  return null;
}

// API-Sports usa G/D/M/F; la DB exige POR/DEF/MED/DEL.
function mapPosition(pos: string | null | undefined): string | null {
  const p = (pos || "").toUpperCase();
  if (p === "G") return "POR";
  if (p === "D") return "DEF";
  if (p === "M") return "MED";
  if (p === "F") return "DEL";
  return null;
}

// Free tier: 10 req/min. Espaciamos 7s entre llamadas por si tocan rate-limit.
const API_GAP_MS = 7000;
let lastCallAt = 0;

async function apiGet<T = unknown>(path: string): Promise<T> {
  const now = Date.now();
  const waitMs = Math.max(0, lastCallAt + API_GAP_MS - now);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastCallAt = Date.now();

  const res = await fetch(`${API}${path}`, {
    headers: { "x-apisports-key": KEY ?? "" },
  });
  if (!res.ok) throw new Error(`API-Sports ${path} → HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.errors && !Array.isArray(json.errors) && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Sports errors: ${JSON.stringify(json.errors)}`);
  }
  return json as T;
}

export async function runSyncOnce(logger: (s: string) => void = console.log): Promise<void> {
  if (!KEY) {
    logger("[sync] API_SPORTS_KEY no definido, skip");
    return;
  }

  const sql = postgres(process.env.SUPABASE_DB_URL!, { max: 1, ssl: "require" });
  try {
    const partidos = await sql<
      { id: number; api_fixture_id: number; local_code: string; away_code: string }[]
    >`
      SELECT id, api_fixture_id,
             equipo_local_codigo AS local_code,
             equipo_visitante_codigo AS away_code
      FROM "mundial-fifa".partidos
      WHERE api_fixture_id IS NOT NULL
        AND estado <> 'finalizado'
    `;

    if (partidos.length === 0) {
      logger("[sync] sin partidos activos para sincronizar");
      return;
    }

    // Mapa api_team_id → codigo en equipos (para cruzar eventos y alineaciones).
    const equipos = await sql<{ codigo: string; api_team_id: number }[]>`
      SELECT codigo, api_team_id FROM "mundial-fifa".equipos WHERE api_team_id IS NOT NULL
    `;
    const teamIdToCode = new Map<number, string>(
      equipos.map((e) => [Number(e.api_team_id), e.codigo])
    );

    for (const p of partidos) {
      const fxJson: any = await apiGet(`/fixtures?id=${p.api_fixture_id}`);
      const fx = fxJson.response?.[0];
      if (!fx) {
        logger(`[sync] fixture ${p.api_fixture_id} sin respuesta, skip`);
        continue;
      }
      const status = mapStatus(fx.fixture?.status?.short ?? "");
      const homeGoals = fx.goals?.home ?? null;
      const awayGoals = fx.goals?.away ?? null;

      await sql`
        UPDATE "mundial-fifa".partidos
        SET goles_local = ${homeGoals},
            goles_visitante = ${awayGoals},
            estado = ${status}
        WHERE id = ${p.id}
      `;
      logger(
        `[sync] partido ${p.id} (${p.local_code}-${p.away_code}) ${homeGoals}-${awayGoals} ${status} min ${fx.fixture?.status?.elapsed ?? "-"}`
      );

      // Eventos
      const evJson: any = await apiGet(`/fixtures/events?fixture=${p.api_fixture_id}`);
      const events: any[] = evJson.response ?? [];
      await sql`DELETE FROM "mundial-fifa".eventos_partido WHERE partido_id = ${p.id}`;
      for (const ev of events) {
        const tipo = mapEventType(ev.type, ev.detail);
        if (!tipo) continue; // tipo fuera del enum válido → skip
        const eqCode = teamIdToCode.get(Number(ev.team?.id)) ?? null;
        const minuto = Math.max(0, Math.min(130, ev.time?.elapsed ?? 0));
        await sql`
          INSERT INTO "mundial-fifa".eventos_partido
            (partido_id, minuto, minuto_extra, tipo, equipo_codigo, jugador, jugador_asiste, detalle)
          VALUES (
            ${p.id},
            ${minuto},
            ${ev.time?.extra ?? null},
            ${tipo},
            ${eqCode},
            ${ev.player?.name ?? null},
            ${ev.assist?.name ?? null},
            ${ev.detail ?? null}
          )
        `;
      }

      // Alineaciones
      const lnJson: any = await apiGet(`/fixtures/lineups?fixture=${p.api_fixture_id}`);
      const lineups: any[] = lnJson.response ?? [];
      await sql`DELETE FROM "mundial-fifa".alineaciones WHERE partido_id = ${p.id}`;
      for (const team of lineups) {
        const eqCode = teamIdToCode.get(Number(team.team?.id));
        if (!eqCode) continue;
        const formacion = team.formation ?? null;
        const insertPlayer = async (pl: any, tipo: "titular" | "suplente") => {
          const name: string = pl?.name ?? "";
          const number: number | null =
            pl?.number != null && pl.number >= 1 && pl.number <= 99 ? pl.number : null;
          const pos = mapPosition(pl?.pos);
          if (!name || !pos) return; // DB exige estos campos válidos
          await sql`
            INSERT INTO "mundial-fifa".alineaciones
              (partido_id, equipo_codigo, formacion, tipo, numero, jugador, posicion, es_capitan)
            VALUES (${p.id}, ${eqCode}, ${formacion}, ${tipo},
                    ${number}, ${name}, ${pos},
                    ${Boolean(pl?.captain)})
          `;
        };
        for (const s of team.startXI ?? []) await insertPlayer(s.player, "titular");
        for (const s of team.substitutes ?? []) await insertPlayer(s.player, "suplente");
      }
      logger(`[sync] partido ${p.id} eventos=${events.length} lineups=${lineups.length}`);
    }
  } finally {
    await sql.end();
  }
}

export function startSyncLoop(intervalMs = 3 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      await runSyncOnce();
    } catch (e) {
      console.error("[sync] error:", e instanceof Error ? e.message : e);
    }
  };
  // Primer tick inmediato, luego cada intervalMs.
  tick();
  return setInterval(tick, intervalMs);
}
