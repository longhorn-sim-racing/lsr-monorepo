import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { daysOverdue, isActionItemStatus } from "@/lib/meetings"
import type { ActionItemRow } from "@/server/queries/meetings"
import type { ActionItemView } from "./action-items"

/** An action item as the lists render it: plain values, formatted in Central time */
export function actionItemView(item: ActionItemRow, now: Date): ActionItemView {
  return {
    id: item.id,
    text: item.text,
    status: isActionItemStatus(item.status) ? item.status : "open",
    ownerId: item.owner?.id ?? null,
    ownerName: item.owner?.displayName ?? null,
    dueDate: item.dueAt ? formatInTimeZone(item.dueAt, DEFAULT_TIMEZONE, "yyyy-MM-dd") : "",
    dueLabel: item.dueAt ? formatInTimeZone(item.dueAt, DEFAULT_TIMEZONE, "EEE, MMM d") : null,
    overdueDays: daysOverdue(item, now),
    doneLabel: item.doneAt ? `Done ${formatInTimeZone(item.doneAt, DEFAULT_TIMEZONE, "MMM d")}` : null,
    meeting: item.meeting ? { id: item.meeting.id, title: item.meeting.title } : null,
  }
}
