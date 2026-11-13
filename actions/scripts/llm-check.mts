// Live check of src/llm.ts against the configured models: MOCK=0 npx tsx scripts/llm-check.mts
import { z } from "zod";
import { complete, llmAvailable } from "../src/llm.js";

console.log("llmAvailable:", llmAvailable());
let failed = 0;
for (const tier of ["fast", "smart"] as const) {
  const t = Date.now();
  try {
    const r = await complete({
      tier,
      system: "Answer briefly.",
      input: "What is 2+3? Give the number and one word describing it.",
      schema: z.object({ answer: z.number(), word: z.string() }),
      schemaName: "sum",
    });
    console.log(tier, "structured OK", JSON.stringify(r), `${Date.now() - t}ms`);
  } catch (e) {
    failed++;
    console.log(tier, "structured FAILED:", String((e as Error)?.message ?? e).slice(0, 400));
  }
}
try {
  const r = await complete({ tier: "fast", system: "Reply with one word.", input: "Say hello." });
  console.log("plain text OK:", JSON.stringify(r));
} catch (e) {
  failed++;
  console.log("plain FAILED:", String((e as Error)?.message ?? e).slice(0, 400));
}
process.exit(failed ? 1 : 0);
