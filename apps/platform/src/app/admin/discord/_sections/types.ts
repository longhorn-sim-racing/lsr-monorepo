import type { ReactNode } from "react"

/**
 * A section of the Community → Discord page (#188, design §13), below the page's own panels: the
 * discord-post track's role-sync rules and standing-rule summary. Registered in `_sections/<track>.tsx`.
 * `Section` is a server component that loads its own data and returns a panel (the kit's Panel), or
 * null to show nothing. If `Section` itself throws (loading its data), a short notice takes its place
 * (SafeSlot).
 */
export type DiscordSection = {
  /** Stable, e.g. "role-sync" */
  id: string
  /** Where it sits among the sections, lowest first */
  order: number
  Section: () => Promise<ReactNode> | ReactNode
}
