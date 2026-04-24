// Smoke test: verify OpenRouter wiring works end-to-end.
// Runs once with: npx tsx scripts/smoke-openrouter.ts
import { generateText } from "ai";
import { getModel } from "@/agent/model-config";

async function main() {
  const start = Date.now();
  const result = await generateText({
    model: getModel("router"),
    prompt: "Say exactly: HELLO_OPENROUTER (one word, no punctuation)",
    maxTokens: 10,
  });
  const ms = Date.now() - start;
  console.log(`Latency: ${ms} ms`);
  console.log(`Response: ${JSON.stringify(result.text)}`);
  console.log(`Tokens in: ${result.usage?.promptTokens} out: ${result.usage?.completionTokens}`);
  if (!result.text.toUpperCase().includes("HELLO_OPENROUTER")) {
    console.error("FAIL: expected HELLO_OPENROUTER in response");
    process.exit(1);
  }
  console.log("OK");
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
