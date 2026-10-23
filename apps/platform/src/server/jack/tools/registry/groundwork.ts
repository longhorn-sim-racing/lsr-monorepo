import type { AnyJackTool } from "../types"
import { webLinksTool } from "../web-links"

/** Jack tools from the groundwork track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt) */
export const TOOLS: AnyJackTool[] = [
  // Deferred, and only offered with the web tools (G8)
  webLinksTool,
]
