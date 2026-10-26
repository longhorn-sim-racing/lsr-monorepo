import type { ReactNode } from "react"

/**
 * A section of the admin Instagram page (#188, design §13): insights (sources-b) and publish history
 * (decks-rooms), below the page's own content. Registered in `_sections/<track>.tsx`. `Section` is a
 * server component that loads its own data and returns a panel (the kit's Panel), or null to show
 * nothing. If `Section` itself throws (loading its data), a short notice takes its place (SafeSlot).
 */
export type InstagramSection = {
  /** Stable, e.g. "insights" */
  id: string
  /** Where it sits among the sections, lowest first */
  order: number
  Section: () => Promise<ReactNode> | ReactNode
}
