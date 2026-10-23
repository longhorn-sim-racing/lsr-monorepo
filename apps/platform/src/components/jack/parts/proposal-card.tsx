import { ArrowRight, FilePen } from "lucide-react"
import { Badge, DetailList } from "@/components/admin/kit"
import type { JackProposalDisplay } from "@/lib/jack/parts"

/**
 * A change Jack proposed (#188, design §4.1), as the reply showed it: the title, summary, the first
 * few changed fields and any counts. A placeholder: G4 replaces it with the live card (full diff,
 * status, Apply and Discard).
 */
export function ProposalCard({ display }: { display: JackProposalDisplay }) {
  const counts = Object.entries(display.counts ?? {})
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-admin-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <FilePen aria-hidden className="size-4 shrink-0 text-admin-subtle" />
        <span className="min-w-0 break-words font-semibold">{display.title}</span>
        <Badge tone="warning">Proposed</Badge>
      </div>
      {display.summary && <p className="break-words text-muted-foreground">{display.summary}</p>}
      {display.preview.length > 0 && (
        <DetailList
          items={display.preview.map((row) => ({
            label: row.label,
            value: (
              <span className="inline-flex flex-wrap items-center gap-x-1.5">
                <span className="text-admin-subtle line-through decoration-admin-subtle/60">{row.before ?? "Not set"}</span>
                <ArrowRight aria-label="becomes" className="size-3 shrink-0 text-admin-subtle" />
                <span className="font-medium">{row.after ?? "Not set"}</span>
              </span>
            ),
          }))}
        />
      )}
      {counts.length > 0 && <p className="text-xs text-muted-foreground tabular-nums">{counts.map(([label, n]) => `${n.toLocaleString("en-US")} ${label}`).join(" · ")}</p>}
      <p className="text-xs text-admin-subtle">Apply and Discard arrive in G4.</p>
    </div>
  )
}
