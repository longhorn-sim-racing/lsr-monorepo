"use client"

import * as TabsPrimitive from "@radix-ui/react-tabs"
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Tone } from "./badge"

/* Tabs: underline style, for splitting one page into a few views (e.g. Attendance / Registration). */

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return <TabsPrimitive.List className={cn("mb-4 flex gap-4 overflow-x-auto border-b", className)}>{children}</TabsPrimitive.List>
}

export function TabsTrigger({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-0.5 pb-2 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-foreground",
        className,
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  )
}

export const TabsContent = TabsPrimitive.Content

/* Notice: an inline banner for warnings, errors and context. */

const NOTICE: Record<Exclude<Tone, "accent">, { box: string; iconClass: string; icon: React.ComponentType<{ className?: string }> }> = {
  neutral: { box: "border-border bg-admin-surface", iconClass: "text-admin-subtle", icon: Info },
  info: { box: "border-tone-info-foreground/20 bg-tone-info", iconClass: "text-tone-info-foreground", icon: Info },
  success: { box: "border-tone-success-foreground/20 bg-tone-success", iconClass: "text-tone-success-foreground", icon: CheckCircle2 },
  warning: { box: "border-tone-warning-foreground/25 bg-tone-warning", iconClass: "text-tone-warning-foreground", icon: AlertTriangle },
  danger: { box: "border-tone-danger-foreground/25 bg-tone-danger", iconClass: "text-tone-danger-foreground", icon: XCircle },
}

export function Notice({
  tone = "neutral",
  title,
  action,
  className,
  children,
}: {
  tone?: Exclude<Tone, "accent">
  title?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  const { box, iconClass, icon: Icon } = NOTICE[tone]
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px]", box, className)}>
      <Icon className={cn("mt-px size-4 shrink-0", iconClass)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/* JsonView: read-only JSON for audit details and debugging panels. */

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-80 overflow-auto rounded-md border bg-admin-surface p-3 font-mono text-xs leading-relaxed text-foreground", className)}>
      {value === undefined ? "—" : JSON.stringify(value, null, 2)}
    </pre>
  )
}

/** A key/value list for detail panels: labels on the left, values on the right. */
export function DetailList({ items, className }: { items: { label: React.ReactNode; value: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]", className)}>
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-admin-subtle">{item.label}</dt>
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
