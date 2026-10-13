import { Check } from "lucide-react"
import { Panel, PanelBody, PanelFooter } from "@/components/admin/kit"
import { cn } from "@/lib/utils"

export type StepState = "done" | "current" | "todo"

/**
 * One numbered step of a multi-step workflow (parse → link → ingest), as a panel. Done steps show a check,
 * the current one is highlighted. Candidate for the kit: any "do these in order" page can use it.
 */
export function StepPanel({
  step,
  title,
  description,
  state,
  footer,
  children,
}: {
  step: number
  title: React.ReactNode
  description?: React.ReactNode
  state: StepState
  footer?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Panel className={cn(state === "current" && "border-primary/50")} aria-current={state === "current" ? "step" : undefined}>
      <div className="flex items-start gap-3 border-b border-admin-row px-4 py-3">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
            state === "done" && "bg-tone-success text-tone-success-foreground",
            state === "current" && "bg-tone-accent text-tone-accent-foreground",
            state === "todo" && "bg-muted text-admin-subtle",
          )}
          aria-label={state === "done" ? `Step ${step}, done` : `Step ${step}`}
        >
          {state === "done" ? <Check className="size-3" aria-hidden /> : step}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children && <PanelBody>{children}</PanelBody>}
      {footer && <PanelFooter>{footer}</PanelFooter>}
    </Panel>
  )
}
