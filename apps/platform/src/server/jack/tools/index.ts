import type { AnyJackTool } from "./types"

/**
 * Every tool Jack can use, in a fixed order (the order is part of the cached prompt, so keep it stable).
 * Filled in by the tools step; the model loop sends whatever is here.
 */
export const JACK_TOOLS: AnyJackTool[] = []

export function findJackTool(name: string): AnyJackTool | undefined {
  return JACK_TOOLS.find((tool) => tool.name === name)
}
