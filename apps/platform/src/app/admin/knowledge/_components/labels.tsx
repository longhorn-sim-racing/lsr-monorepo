import type { KnowledgeSource } from "@prisma/client"
import { Badge, ToneText } from "@/components/admin/kit"
import { describeAge, formatAge, type KnowledgeAge } from "@/lib/jack/knowledge"

/** Where an entry came from, for people */
export const SOURCE_LABEL: Record<KnowledgeSource, string> = {
  MANUAL: "Written by an officer",
  JACK: "Saved by Jack",
  SEED: "From the reviewed seed",
}

/** How a version was made, for people (KnowledgeEntryVersion.via) */
export const VIA_LABEL: Record<string, string> = { admin: "Knowledge page", jack: "Jack", seed: "Seed" }

/** An entry's age: plain under 180 days, a warning past it (Jack mentions the age then too) */
export function AgeBadge({ age }: { age: KnowledgeAge }) {
  const label = age.days < 1 ? "today" : formatAge(age.days)
  return (
    <span title={describeAge(age)}>
      {age.stale ? <Badge tone="warning">{label} old</Badge> : <ToneText>{label}</ToneText>}
    </span>
  )
}

/** The status pills an entry shows in the list and on its page */
export function EntryStatus({ unreviewed, archived }: { unreviewed: boolean; archived: boolean }) {
  if (archived) return <Badge>Archived</Badge>
  if (unreviewed) return <Badge tone="warning">Not reviewed</Badge>
  return null
}
