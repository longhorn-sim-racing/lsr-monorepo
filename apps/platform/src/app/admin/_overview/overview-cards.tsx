import { SafeSlot } from "@/components/admin/safe-slot"
import { OVERVIEW_CARDS } from "./cards"

/**
 * The tracks' Overview cards (#188, design §13), below the page's own panels, in their `order`. A card
 * that fails shows a short notice instead. Renders nothing while no track has added one.
 */
export function OverviewCards() {
  if (!OVERVIEW_CARDS.length) return null
  return (
    <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {OVERVIEW_CARDS.map((card) => (
        <SafeSlot key={card.id} id={card.id} where="overview" render={card.Card} />
      ))}
    </div>
  )
}
