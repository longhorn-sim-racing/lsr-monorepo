import { instagramInsightsTool } from "../instagram-insights"
import { twitchStatsTool } from "../twitch-stats"
import type { AnyJackTool } from "../types"

/**
 * Jack tools from the sources-b track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt).
 * Both are deferred (found through tool search) and read only what the site stores.
 */
export const TOOLS: AnyJackTool[] = [twitchStatsTool, instagramInsightsTool]
