import type { EventStatus } from "@prisma/client"
import { Badge, type Tone } from "@/components/admin/kit"

export const EVENT_STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "POSTPONED"] as const satisfies readonly EventStatus[]

export const EVENT_STATUS: Record<EventStatus, { label: string; tone: Tone; meaning: string }> = {
  DRAFT: { label: "Draft", tone: "neutral", meaning: "Hidden from the public site." },
  SCHEDULED: { label: "Scheduled", tone: "info", meaning: "Hidden until its publish time, then public." },
  PUBLISHED: { label: "Published", tone: "success", meaning: "Public, and it hasn't started yet." },
  IN_PROGRESS: { label: "In progress", tone: "accent", meaning: "Public, and happening now." },
  COMPLETED: { label: "Completed", tone: "neutral", meaning: "Public, and over." },
  CANCELLED: { label: "Cancelled", tone: "danger", meaning: "Public, and marked as not happening." },
  POSTPONED: { label: "Postponed", tone: "warning", meaning: "Public, and marked as delayed." },
}

export function EventStatusBadge({ status }: { status: EventStatus }) {
  const { label, tone } = EVENT_STATUS[status]
  return <Badge tone={tone}>{label}</Badge>
}
