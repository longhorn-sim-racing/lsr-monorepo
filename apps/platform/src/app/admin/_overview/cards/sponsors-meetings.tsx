import { formatInTimeZone } from "date-fns-tz"
import { Badge } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { ACTION_ITEMS_PAGE, centralDay, daysOverdue, meetingPath } from "@/lib/meetings"
import { listActionItems } from "@/server/queries/meetings"
import { OverviewPanel } from "../overview-list"
import type { OverviewCard } from "./types"

/** Action items shown on the card: overdue ones, then those due in the next week */
const SHOWN = 6
const WEEK_MS = 7 * 86_400_000

/** Open action items that are overdue or due within a week, overdue first */
async function ActionItemsCard() {
  const now = new Date()
  const weekOut = centralDay(new Date(now.getTime() + WEEK_MS))
  const open = await listActionItems({ status: "open" }, now)
  const soon = open.filter((item) => item.overdue || (item.dueAt && centralDay(item.dueAt) <= weekOut))
  const overdue = soon.filter((item) => item.overdue).length
  return (
    <OverviewPanel
      title="Action items"
      description={overdue ? `${overdue} overdue · due in the next 7 days below` : "Due in the next 7 days"}
      viewAll={{ href: ACTION_ITEMS_PAGE, label: "Action items" }}
      empty="Nothing overdue or due this week."
      more={soon.length > SHOWN ? `${soon.length - SHOWN} more not shown` : undefined}
      items={soon.slice(0, SHOWN).map((item) => ({
        key: item.id,
        href: item.meeting ? meetingPath(item.meeting.id) : item.owner ? `${ACTION_ITEMS_PAGE}?owner=${encodeURIComponent(item.owner.handle)}` : ACTION_ITEMS_PAGE,
        primary: item.text,
        secondary: [item.owner?.displayName ?? "No owner", item.meeting?.title].filter(Boolean).join(" · "),
        meta: item.overdue ? (
          <Badge tone="warning">{daysOverdue(item, now)}d overdue</Badge>
        ) : (
          <span>Due {formatInTimeZone(item.dueAt!, DEFAULT_TIMEZONE, "EEE, MMM d")}</span>
        ),
      }))}
    />
  )
}

/** Overview cards from the sponsors-meetings track. The registry joins every track's cards and sorts them by order */
export const CARDS: OverviewCard[] = [{ id: "action-items", order: 40, Card: ActionItemsCard }]
