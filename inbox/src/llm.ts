// The one LLM helper for this service (shared contract: `complete({tier, system, input, schema?})`).
// Uses the official `openai` SDK Responses API with Structured Outputs via `zodTextFormat`.
// In MOCK mode or without an API key it throws `LLMUnavailable` so callers fall back to heuristics
// and never touch the network.
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { MOCK_ENV as MOCK, OPENAI_API_KEY, OPENAI_MODEL_FAST, OPENAI_MODEL_SMART } from "./config.js";

export class LLMUnavailable extends Error {
  constructor(message = "LLM unavailable (MOCK=1 or OPENAI_API_KEY empty)") {
    super(message);
    this.name = "LLMUnavailable";
  }
}

export type Tier = "fast" | "smart";

/** Content parts for multimodal input. Screenshots go in as base64 data URLs. */
export type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" };

export interface CompleteOptions<T> {
  tier: Tier;
  system: string;
  input: string | InputPart[];
  schema?: z.ZodType<T>;
  schemaName?: string;
}

/** False with MOCK=1 or without an API key; callers then use the deterministic rules. */
export function llmAvailable(): boolean {
  return !MOCK && OPENAI_API_KEY !== "";
}

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (MOCK || !OPENAI_API_KEY) throw new LLMUnavailable();
  client ??= new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}

export function modelFor(tier: Tier): string {
  return tier === "smart" ? OPENAI_MODEL_SMART : OPENAI_MODEL_FAST;
}

function toUserContent(input: string | InputPart[]) {
  if (typeof input === "string") return input;
  return input.map((p) => (p.type === "input_image" ? { ...p, detail: p.detail ?? "auto" } : p));
}

/** Structured call: returns the zod-validated object. Without a schema: returns the model's text. */
export async function complete<T>(opts: CompleteOptions<T> & { schema: z.ZodType<T> }): Promise<T>;
export async function complete(opts: CompleteOptions<never> & { schema?: undefined }): Promise<string>;
export async function complete<T>(opts: CompleteOptions<T>): Promise<T | string> {
  const openai = getClient();
  const model = modelFor(opts.tier);
  const input = [
    { role: "system" as const, content: opts.system },
    { role: "user" as const, content: toUserContent(opts.input) },
  ];

  if (opts.schema) {
    const response = await openai.responses.parse({
      model,
      input,
      text: { format: zodTextFormat(opts.schema, opts.schemaName ?? "result") },
    });
    const parsed = response.output_parsed;
    if (parsed === null || parsed === undefined) {
      throw new Error(`LLM returned no parsable output (status ${response.status ?? "unknown"})`);
    }
    return parsed as T;
  }

  const response = await openai.responses.create({ model, input });
  return response.output_text;
}
