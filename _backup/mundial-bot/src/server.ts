import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mastra } from "./mastra/index.js";
import { startSyncLoop } from "./sync/apiSportsSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

interface ChatBody {
  message: string;
  threadId?: string;
  agent?: "mundialAgent" | "puntosVioletaAgent" | "alessandraAgent";
  userLocation?: { lat: number; lng: number; accuracy?: number };
}

const ALLOWED_AGENTS = new Set([
  "mundialAgent",
  "puntosVioletaAgent",
  "alessandraAgent",
]);

app.post("/chat", async (req: Request<unknown, unknown, ChatBody>, res: Response) => {
  const { message, threadId, agent: agentId, userLocation } = req.body ?? {};
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message requerido" });
    return;
  }
  const selectedAgent = ALLOWED_AGENTS.has(agentId ?? "") ? agentId! : "mundialAgent";

  let finalMessage = message;
  if (
    userLocation &&
    typeof userLocation.lat === "number" &&
    typeof userLocation.lng === "number" &&
    Number.isFinite(userLocation.lat) &&
    Number.isFinite(userLocation.lng)
  ) {
    const acc =
      typeof userLocation.accuracy === "number" && Number.isFinite(userLocation.accuracy)
        ? ` (precisión ~${Math.round(userLocation.accuracy)}m)`
        : "";
    finalMessage = `[ubicación del usuario: lat=${userLocation.lat.toFixed(6)}, lng=${userLocation.lng.toFixed(6)}${acc}]\n${message}`;
  }
  console.log(
    `[chat] agent=${selectedAgent} thread=${threadId ?? "anon"} hasLoc=${!!userLocation} msg=${JSON.stringify(finalMessage.slice(0, 200))}`
  );

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const agent = mastra.getAgent(selectedAgent);
    const stream = await agent.stream(
      [{ role: "user", content: finalMessage }],
      {
        memory: {
          thread: threadId ?? "anon",
          resource: "web-user",
        },
      }
    );

    for await (const chunk of stream.textStream) {
      send("token", { text: chunk });
    }

    send("done", {});
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("chat error:", msg);
    send("error", { error: msg });
    res.end();
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Mundial bot listening on http://localhost:${PORT}`);
  // Sync en background: primer tick inmediato + cada 3 min.
  if (process.env.API_SPORTS_KEY) {
    startSyncLoop(3 * 60 * 1000);
    console.log("API-Sports sync loop started (every 3 min).");
  } else {
    console.log("API_SPORTS_KEY no set, sync desactivado.");
  }
});
