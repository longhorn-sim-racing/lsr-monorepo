import type { JackPersonaKey } from "@/lib/jack/types"

/**
 * Which Claude model each persona runs on, and how hard it thinks. Thinking is adaptive and can't be
 * turned off on these models; effort is the control (Opus 5.5 and Haiku 5.5 default to medium, Sonnet
 * 5.5 to high, so it's always set). `maxTokens` is per API call and covers thinking plus the reply.
 */
export type JackModelConfig = {
  persona: JackPersonaKey
  model: string
  effort: "low" | "medium" | "high" | "xhigh" | "max"
  maxTokens: number
  /** Server-side refusal fallback ("default" routing). Not offered for Haiku 5.5 */
  fallbacks: boolean
}

export const JACK_MODELS: Record<JackPersonaKey, JackModelConfig> = {
  // Every answer by default: data questions with a few tool calls each
  jack: { persona: "jack", model: "claude-sonnet-5-5", effort: "medium", maxTokens: 16_000, fallbacks: true },
  // Hard questions, chosen per room
  lift: { persona: "lift", model: "claude-opus-5-5", effort: "high", maxTokens: 32_000, fallbacks: true },
  // Side jobs (naming rooms): short, cheap, no tools
  stand: { persona: "stand", model: "claude-haiku-5-5", effort: "low", maxTokens: 1_024, fallbacks: false },
}

/** Beta headers a room reply sends (see model-loop.ts for what each is for) */
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"
