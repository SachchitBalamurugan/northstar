// The ONLY place that talks to a model provider. Swap providers by editing this file.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { MOCK, MODEL_FAST, MODEL_SMART, OPENAI_API_KEY } from "./config.js";

let client: OpenAI | null = null;

/** False in MOCK mode or when no key is configured. Callers must have a non-LLM fallback. */
export function llmAvailable(): boolean {
  return !MOCK && OPENAI_API_KEY.length > 0;
}

export interface CompleteArgs<S extends z.ZodType | undefined = undefined> {
  tier: "fast" | "smart";
  system: string;
  input: string;
  /** zod schema → Structured Outputs. The root must be a z.object(). */
  schema?: S;
  /** Name for the JSON schema (letters/underscores). */
  schemaName?: string;
  /** base64 PNGs (no data: prefix) sent as image_url parts. */
  images?: string[];
}

export async function complete<S extends z.ZodType>(
  args: CompleteArgs<S> & { schema: S },
): Promise<z.infer<S>>;
export async function complete(args: CompleteArgs<undefined>): Promise<string>;
export async function complete(args: CompleteArgs<any>): Promise<unknown> {
  if (!llmAvailable()) throw new Error("LLM unavailable (MOCK=1 or OPENAI_API_KEY missing)");
  const model = args.tier === "smart" ? MODEL_SMART : MODEL_FAST;
  if (!model) throw new Error(`OPENAI_MODEL_${args.tier.toUpperCase()} is not set`);
  client ??= new OpenAI({ apiKey: OPENAI_API_KEY });

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: args.input },
    ...(args.images ?? []).map((b64) => ({
      type: "image_url" as const,
      image_url: { url: `data:image/png;base64,${b64}` },
    })),
  ];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: args.system },
    { role: "user", content: userContent },
  ];

  if (args.schema) {
    const res = await client.chat.completions.parse({
      model,
      messages,
      response_format: zodResponseFormat(args.schema, args.schemaName ?? "result"),
    });
    const msg = res.choices[0]?.message;
    if (!msg?.parsed) throw new Error(`Model returned no structured output: ${msg?.refusal ?? "empty"}`);
    return msg.parsed;
  }
  const res = await client.chat.completions.create({ model, messages });
  return res.choices[0]?.message?.content ?? "";
}
