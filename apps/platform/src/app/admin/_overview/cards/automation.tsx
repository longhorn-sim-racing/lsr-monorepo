import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { Badge, Button, Panel, PanelHeader, type Tone } from "@/components/admin/kit"
import { DIGEST_SETTINGS_PATH } from "@/lib/jack/recurring"
import { failedChecks, needingAttention, runDigestChecks } from "@/server/automation/run-checks"
import type { DigestCheckResult } from "@/server/automation/types"
import type { OverviewCard } from "./types"

/** Items shown under each check; its page has the rest */
const ITEMS_PER_CHECK = 3

const TONE: Record<DigestCheckResult["severity"], Tone> = { danger: "danger", warning: "warning", info: "info" }

/**
 * "Needs attention" on the Overview (#188, design §11.2 and §13): every track's digest check, run live
 * when the page loads, most urgent first, each with its first few items. The weekly digest posts the
 * same checks. A check that fails or takes too long is named at the bottom instead of breaking the card.
 */
async function NeedsAttentionCard() {
  const report = await runDigestChecks()
  const found = needingAttention(report)
  const failed = failedChecks(report)
  const total = found.reduce((sum, outcome) => sum + outcome.result.count, 0)

  return (
    <Panel className="flex flex-col lg:col-span-2">
      <PanelHeader
        title="Needs attention"
        description={total ? `${total} ${total === 1 ? "thing" : "things"} across the console, most urgent first. The weekly digest posts the same list.` : "The weekly digest's checks, as of now."}
        actions={
          <Button size="sm" variant="ghost" asChild>
            <Link href={DIGEST_SETTINGS_PATH}>Digest settings</Link>
          </Button>
        }
      />
      {found.length ? (
        <ul className="grid grid-cols-1 md:grid-cols-2">
          {found.map(({ check, result }) => {
            // Only the items cut here: a check's count can be in other units than its items (addresses, by email)
            const more = result.items.length - ITEMS_PER_CHECK
            return (
              <li key={check.id} className="flex min-w-0 flex-col border-b border-admin-row md:odd:border-r">
                <Link href={check.href} className="group flex items-center gap-2.5 px-4 pb-1.5 pt-2.5 text-[13px] hover:bg-admin-surface">
                  <Badge tone={TONE[result.severity]} className="tabular-nums">
                    {result.count}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-semibold">{check.label}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-admin-subtle group-hover:text-foreground" aria-hidden />
                </Link>
                <ul className="flex flex-col pb-2">
                  {result.items.slice(0, ITEMS_PER_CHECK).map((item, i) => (
                    <li key={`${item.href}-${i}`} className="min-w-0">
                      <Link href={item.href} className="flex min-w-0 flex-col px-4 py-1 pl-[3.25rem] text-xs hover:bg-admin-surface">
                        <span className="truncate font-medium text-foreground">{item.title}</span>
                        {item.detail ? <span className="truncate text-admin-subtle">{item.detail}</span> : null}
                      </Link>
                    </li>
                  ))}
                  {more > 0 ? <li className="px-4 py-0.5 pl-[3.25rem] text-xs text-admin-subtle">and {more} more</li> : null}
                </ul>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="px-4 py-5 text-[13px] text-muted-foreground">Nothing needs attention right now.</p>
      )}
      {failed.length ? (
        <p className="mt-auto border-t border-admin-row px-4 py-2 text-xs text-admin-subtle">Couldn&apos;t check: {failed.map((outcome) => outcome.check.label).join(", ")}</p>
      ) : null}
    </Panel>
  )
}

/** Overview cards from the automation track. The registry joins every track's cards and sorts them by order */
export const CARDS: OverviewCard[] = [{ id: "needs-attention", order: 0, Card: NeedsAttentionCard }]
