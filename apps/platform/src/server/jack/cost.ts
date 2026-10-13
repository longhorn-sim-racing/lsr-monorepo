import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages"

/** Dollars per million tokens. Cache writes (5-minute TTL) cost 1.25x input; cache reads are listed per model */
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number }

const price = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
})

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": price(2, 10, 0.2), // Jack
  "claude-opus-5-5": price(4, 20, 0.2), // Lift
  "claude-haiku-5-5": price(0.1, 0.5, 0.01), // Stand (prompts up to 100K tokens; ours are tiny)
  // A refused request can be answered by a fallback model, billed at that model's rates
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
}

/**
 * Tokens one or more API calls used. `inputTokens` is the uncached remainder only; the whole prompt
 * is inputTokens + cacheWriteTokens + cacheReadTokens.
 */
export type TokenUsage = { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }

export const NO_TOKENS: TokenUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** What `usage` cost on `model`. An unknown model is priced as `fallbackModel` (the one we asked for) */
export function costUsd(model: string, usage: TokenUsage, fallbackModel?: string): number {
  const rates = MODEL_PRICES[model] ?? (fallbackModel ? MODEL_PRICES[fallbackModel] : undefined)
  if (!rates) throw new Error(`No price for model ${model}`)
  const dollars =
    (usage.inputTokens * rates.input +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.cacheReadTokens * rates.cacheRead +
      usage.outputTokens * rates.output) /
    1_000_000
  return roundUsd(dollars)
}

/** JackMessage.costUsd keeps 6 decimals */
export function roundUsd(dollars: number): number {
  return Math.round(dollars * 1_000_000) / 1_000_000
}

/**
 * Token usage of one API response, by the model that ran it. With a refusal fallback a response can
 * span several attempts on different models; `usage.iterations` is then the per-attempt record (the
 * top-level numbers cover only the attempt that answered), so it wins when present.
 */
export function usageByModel(message: Pick<BetaMessage, "model" | "usage">, requestedModel: string): Map<string, TokenUsage> {
  const out = new Map<string, TokenUsage>()
  const add = (model: string, usage: TokenUsage) => out.set(model, addTokens(out.get(model) ?? NO_TOKENS, usage))
  const attempts = (message.usage.iterations ?? []).filter(
    (entry) => entry.type === "message" || entry.type === "fallback_message"
  ) as { model: string | null; input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }[]

  if (attempts.length) {
    for (const attempt of attempts) {
      add(attempt.model ?? requestedModel, {
        inputTokens: attempt.input_tokens,
        cacheWriteTokens: attempt.cache_creation_input_tokens ?? 0,
        cacheReadTokens: attempt.cache_read_input_tokens ?? 0,
        outputTokens: attempt.output_tokens,
      })
    }
    return out
  }

  add(message.model || requestedModel, {
    inputTokens: message.usage.input_tokens,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    outputTokens: message.usage.output_tokens,
  })
  return out
}

/** Adds up a reply's API calls: tokens per model, and what they cost */
export class UsageTally {
  private readonly byModel = new Map<string, TokenUsage>()
  calls = 0

  constructor(private readonly requestedModel: string) {}

  add(message: Pick<BetaMessage, "model" | "usage">): void {
    this.calls++
    for (const [model, usage] of usageByModel(message, this.requestedModel)) {
      this.byModel.set(model, addTokens(this.byModel.get(model) ?? NO_TOKENS, usage))
    }
  }

  get tokens(): TokenUsage {
    let total = NO_TOKENS
    for (const usage of this.byModel.values()) total = addTokens(total, usage)
    return total
  }

  get costUsd(): number {
    let total = 0
    for (const [model, usage] of this.byModel) total += costUsd(model, usage, this.requestedModel)
    return roundUsd(total)
  }

  /** The models that answered, the one we asked for first (several when a refusal fell back) */
  get models(): string[] {
    const models = [...this.byModel.keys()]
    return models.length ? models.sort((a, b) => Number(b === this.requestedModel) - Number(a === this.requestedModel)) : [this.requestedModel]
  }
}

/**
 * A tally as JackMessage and JackUsage save it. `inputTokens` there is everything not read from the
 * cache (uncached input plus cache writes); the whole prompt is that plus `cacheReadTokens`
 */
export function savedUsage(tally: UsageTally) {
  const tokens = tally.tokens
  return {
    model: tally.models.join(","),
    inputTokens: tokens.inputTokens + tokens.cacheWriteTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    costUsd: tally.costUsd,
  }
}
