import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { Button, Panel, PanelHeader } from "@/components/admin/kit"
import { cn } from "@/lib/utils"

export type OverviewItem = {
  key: string
  href: string
  primary: React.ReactNode
  secondary?: React.ReactNode
  /** Right-hand side: a badge, a count, a time */
  meta?: React.ReactNode
}

/**
 * A dashboard card: a titled panel holding a short list of linked rows, with a link to the full page.
 * Candidate for the kit (a "LinkList" panel), since other overview-style pages will want the same.
 */
export function OverviewPanel({
  title,
  description,
  viewAll,
  items,
  empty,
  more,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  viewAll?: { href: string; label: string }
  items: OverviewItem[]
  /** Shown when there are no items; say plainly that nothing needs doing */
  empty: React.ReactNode
  /** e.g. "and 3 more" when the list is cut short */
  more?: React.ReactNode
  className?: string
}) {
  return (
    <Panel className={cn("flex flex-col", className)}>
      <PanelHeader
        title={title}
        description={description}
        actions={
          viewAll && (
            <Button size="sm" variant="ghost" asChild>
              <Link href={viewAll.href}>{viewAll.label}</Link>
            </Button>
          )
        }
      />
      {items.length === 0 ? (
        <p className="px-4 py-5 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.key} className="border-b border-admin-row last:border-b-0">
              <Link href={item.href} className="group flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-admin-surface">
                {/* On phones the meta drops under the text instead of squeezing it */}
                <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">{item.primary}</span>
                    {item.secondary && <span className="truncate text-xs text-admin-subtle">{item.secondary}</span>}
                  </span>
                  {item.meta && <span className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">{item.meta}</span>}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-admin-subtle group-hover:text-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more && <p className="mt-auto border-t border-admin-row px-4 py-2 text-xs text-admin-subtle">{more}</p>}
    </Panel>
  )
}

/** A Stat that links somewhere. */
export function StatLink({ href, label, value, hint }: { href: string; label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Link href={href} className="flex min-w-0 flex-col gap-0.5 rounded-lg border bg-card px-4 py-3 outline-none hover:border-input hover:bg-admin-surface focus-visible:ring-2 focus-visible:ring-ring/40">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-admin-subtle">{hint}</span>}
    </Link>
  )
}
