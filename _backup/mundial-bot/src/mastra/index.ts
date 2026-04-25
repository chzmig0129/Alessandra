import { Mastra } from "@mastra/core";
import { mundialAgent } from "./agents/mundialAgent.js";
import { puntosVioletaAgent } from "./agents/puntosVioletaAgent.js";
import { alessandraAgent } from "./agents/alessandraAgent.js";

export const mastra = new Mastra({
  agents: { mundialAgent, puntosVioletaAgent, alessandraAgent },
});
