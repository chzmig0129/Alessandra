import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// TODO(phase-2): integrar API-Football (https://www.api-football.com/)
// - Usar fetch con API key en env (API_FOOTBALL_KEY)
// - Endpoint /fixtures?live=all filtrando por competition id del Mundial 2026
// - Mapear matchId/teamCode → fixture.id de API-Football
// - Cachear respuestas por ~30s para no pegarle en cada tool call

export const getLiveMatchData = createTool({
  id: "getLiveMatchData",
  description:
    "Obtiene datos en vivo de un partido EN CURSO (marcador al minuto, eventos recientes, alineaciones del día). Úsala SOLO cuando el usuario pregunte por algo que está ocurriendo ahora. Para calendario, resultados históricos o info estática, usa queryDatabase.",
  inputSchema: z.object({
    matchId: z
      .string()
      .optional()
      .describe("Número/ID del partido en la base (numero_partido)."),
    teamCode: z
      .string()
      .optional()
      .describe("Código FIFA de 3 letras del equipo (MEX, USA, CAN...)."),
  }),
  outputSchema: z.object({
    status: z.string(),
    message: z.string(),
  }),
  execute: async () => {
    return {
      status: "not_implemented",
      message:
        "Live data integration with API-Football pending in phase 2.",
    };
  },
});
