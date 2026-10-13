import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { cn } from "@/lib/utils"

/** Top of every admin page: title, one line of context, and the page's actions on the right. */
export function PageHeader({
  title,
  description,
  back,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  /** For detail pages: a link back to the list */
  back?: { href: string; label: string }
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("mb-4 flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        {back && (
          <Link href={back.href} className="mb-1 inline-flex w-fit items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-3.5" aria-hidden />
            {back.label}
          </Link>
        )}
        <h1 className="font-display text-[26px] font-semibold leading-tight">{title}</h1>
        {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** A white card. Most admin content sits in one. */
export function Panel({ className, children, ...props }: React.ComponentProps<"section">) {
  return (
    <section className={cn("min-w-0 rounded-lg border bg-card", className)} {...props}>
      {children}
    </section>
  )
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-admin-row px-4 py-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function PanelBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-4 py-3.5", className)}>{children}</div>
}

export function PanelFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-wrap items-center justify-between gap-2.5 border-t border-admin-row px-4 py-3", className)}>{children}</div>
}

/**
 * A list with an optional side panel (e.g. the edit panel). Side by side on wide screens; the panel wraps
 * under the list on narrow ones.
 */
export function SplitLayout({ main, side, className }: { main: React.ReactNode; side?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start gap-4", className)}>
      <div className="min-w-0 flex-[999_1_560px]">{main}</div>
      {side && <div className="min-w-0 flex-[1_1_360px] xl:sticky xl:top-[60px]">{side}</div>}
    </div>
  )
}

/** A small number with a label, for summary strips above lists. */
export function Stat({ label, value, hint, className }: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-lg border bg-card px-4 py-3", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-admin-subtle">{hint}</span>}
    </div>
  )
}

export function StatRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mb-4 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3", className)}>{children}</div>
}

/** What a list or panel shows when there's nothing in it. Say why, and offer the next step. */
export function EmptyState({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-6 py-10 text-center", className)}>
      <p className="text-sm font-semibold">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
