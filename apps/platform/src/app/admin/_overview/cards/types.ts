import type { ReactNode } from "react"

/**
 * A card on the admin Overview (#188, design §13): site traffic, streams, Discord activity, "Needs
 * attention". Registered in `cards/<track>.tsx`. `Card` is a server component: it loads its own data
 * and returns a panel (OverviewPanel, or the kit's Panel), or null to show nothing. A card that throws
 * is replaced by a short notice, so one failing source never takes the Overview down.
 */
export type OverviewCard = {
  /** Stable, e.g. "site-traffic" */
  id: string
  /** Where it sits among the cards, lowest first */
  order: number
  Card: () => Promise<ReactNode> | ReactNode
}
