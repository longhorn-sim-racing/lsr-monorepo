import { kindsForTool } from "@/server/jack/proposals/registry"
import { proposeTools } from "../propose"
import type { AnyJackTool } from "../types"
import { webLinksTool } from "../web-links"

/**
 * Jack tools from the groundwork track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt).
 * The propose_* tools come first, one per tool that has a proposal kind (../propose.ts): a track's kind makes its tool appear.
 */
export const TOOLS: AnyJackTool[] = [
  ...proposeTools(kindsForTool),
  // Deferred, and only offered with the web tools (G8)
  webLinksTool,
]
