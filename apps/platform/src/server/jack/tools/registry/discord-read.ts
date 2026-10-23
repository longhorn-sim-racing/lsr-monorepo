import { discordActivityTool, discordPollsTool } from "../discord"
import type { AnyJackTool } from "../types"

/**
 * Jack tools from the discord-read track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt).
 * Both are deferred (found through tool search). Discord search itself is a source of the club-data track's `search`.
 */
export const TOOLS: AnyJackTool[] = [discordActivityTool, discordPollsTool]
