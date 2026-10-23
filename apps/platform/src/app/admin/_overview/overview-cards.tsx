import { Notice } from "@/components/admin/kit"
import { OVERVIEW_CARDS, type OverviewCard } from "./cards"

/**
 * The tracks' Overview cards (#188, design §13), below the page's own panels, in their `order`.
 * Renders nothing while no track has added one.
 */
export function OverviewCards() {
  if (!OVERVIEW_CARDS.length) return null
  return (
    <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {OVERVIEW_CARDS.map((card) => (
        <SafeCard key={card.id} card={card} />
      ))}
    </div>
  )
}

/** One card; if loading its data throws, a short notice takes its place instead of the whole page failing */
async function SafeCard({ card }: { card: OverviewCard }) {
  try {
    return await card.Card()
  } catch (error) {
    console.error(`[overview] The ${card.id} card failed:`, error)
    return (
      <Notice tone="warning" title="Couldn't load this card">
        The rest of the Overview is up to date. Reload to try again.
      </Notice>
    )
  }
}
