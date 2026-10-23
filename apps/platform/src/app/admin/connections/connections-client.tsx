"use client"

import { useOptimistic, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, PlugZap, X } from "lucide-react"
import { Badge, Button, DetailList, EmptyState, Panel, PanelHeader, SwitchField, useConfirm, type Tone } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import { runConnectorSmokeAction, setConnectorEnabledAction } from "./actions"
import type { ConnectionView, When } from "./view"

const STATE: Record<ConnectionView["state"], { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "success" },
  off: { label: "Off", tone: "neutral" },
  not_configured: { label: "Not set up", tone: "warning" },
  error: { label: "Failing", tone: "danger" },
  planned: { label: "Not built yet", tone: "neutral" },
}

function Time({ when }: { when: When }) {
  return <time title={when.at}>{when.ago}</time>
}

function EnvList({ env }: { env: ConnectionView["env"] }) {
  if (!env.length) return <span className="text-admin-subtle">None needed</span>
  return (
    <ul className="flex flex-wrap gap-1.5">
      {env.map(({ name, present }) => (
        <li
          key={name}
          className={cn(
            "inline-flex max-w-full items-center gap-1 break-all rounded px-1.5 py-px font-mono text-xs",
            present ? "bg-admin-surface text-muted-foreground" : "bg-tone-warning text-tone-warning-foreground",
          )}
        >
          {present ? <Check className="size-3 shrink-0" aria-hidden /> : <X className="size-3 shrink-0" aria-hidden />}
          {name}
          <span className="sr-only">{present ? "(set)" : "(missing)"}</span>
        </li>
      ))}
    </ul>
  )
}

function details(row: ConnectionView) {
  const items: { label: React.ReactNode; value: React.ReactNode }[] = [{ label: "Env", value: <EnvList env={row.env} /> }]
  if (row.missingSettings.length) {
    items.push({
      label: "Settings",
      value: (
        <span className="text-tone-warning-foreground">
          Missing <span className="font-mono text-xs">{row.missingSettings.join(", ")}</span>
        </span>
      ),
    })
  }
  items.push({ label: "Last sync", value: row.lastSync ? <Time when={row.lastSync} /> : <span className="text-admin-subtle">Never</span> })
  if (row.lastError) {
    items.push({
      label: "Last error",
      value: (
        <span className="flex flex-col gap-0.5">
          <span className={cn("break-words", row.lastError.current ? "text-tone-danger-foreground" : "text-muted-foreground")}>{row.lastError.text}</span>
          <span className="text-xs text-admin-subtle">
            <Time when={row.lastError} />
            {!row.lastError.current && " · it has synced since"}
          </span>
        </span>
      ),
    })
  }
  items.push({
    label: "Smoke test",
    value: !row.hasSmoke ? (
      <span className="text-admin-subtle">No smoke test yet</span>
    ) : row.lastSmoke ? (
      <span className="flex flex-col gap-0.5">
        <span className={row.lastSmoke.ok ? "text-tone-success-foreground" : "text-tone-danger-foreground"}>
          {row.lastSmoke.ok ? "Passed" : "Failed"}: {row.lastSmoke.summary}
        </span>
        <span className="text-xs text-admin-subtle">
          <Time when={row.lastSmoke} />
          {row.lastSmoke.by && ` · ${row.lastSmoke.by}`}
        </span>
      </span>
    ) : (
      <span className="text-admin-subtle">Never run</span>
    ),
  })
  for (const detail of row.details) items.push({ label: detail.label, value: detail.value })
  return items
}

/** The on/off switch: admins only, confirmed when switching on without a passing smoke test, optimistic while saving */
function ConnectionSwitch({ row, isAdmin }: { row: ConnectionView; isAdmin: boolean }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [switching, startSwitch] = useTransition()
  const [enabled, setOptimisticEnabled] = useOptimistic(row.enabled)
  // Off always works; on needs the connector built and set up (the action checks too)
  const blocked = !enabled && (row.state === "planned" || row.state === "not_configured")

  async function toggle(next: boolean) {
    if (next && !row.lastSmoke?.ok) {
      const ok = await confirm({
        title: `Switch ${row.label} on?`,
        description: row.hasSmoke
          ? "It hasn't passed a smoke test yet. Connections go on one at a time, after their smoke test passes: its sync jobs and Jack's tools use the live service as soon as it's on."
          : "It has no smoke test yet. Its sync jobs and Jack's tools use the live service as soon as it's on.",
        confirmLabel: "Switch on",
      })
      if (!ok) return
    }
    startSwitch(async () => {
      setOptimisticEnabled(next)
      try {
        const result = await setConnectorEnabledAction(row.id, next)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(`${row.label} is ${next ? "on" : "off"}`)
        router.refresh()
      } catch {
        toast.error("Couldn't change it. Try again.")
      }
    })
  }

  return (
    <SwitchField
      label={enabled ? "On" : "Off"}
      description={isAdmin && blocked && row.state === "not_configured" ? "Set it up first" : undefined}
      aria-label={`${row.label}: ${enabled ? "on" : "off"}`}
      checked={enabled}
      onCheckedChange={toggle}
      disabled={!isAdmin || switching || blocked}
      className="items-center gap-2.5"
    />
  )
}

function SmokeButton({ row }: { row: ConnectionView }) {
  const router = useRouter()
  const [smoking, startSmoke] = useTransition()
  const notSetUp = row.state === "not_configured"

  function smoke() {
    startSmoke(async () => {
      try {
        const result = await runConnectorSmokeAction(row.id)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        if (result.data.ok) toast.success(`${row.label} passed: ${result.data.summary}`)
        else toast.error(`${row.label} failed: ${result.data.summary}`)
        router.refresh()
      } catch {
        toast.error("The smoke test didn't finish. Try again.")
      }
    })
  }

  return (
    <Button size="sm" onClick={smoke} pending={smoking} disabled={notSetUp} title={notSetUp ? "Set it up first" : "Calls the live service once; works while it's switched off"}>
      <PlugZap aria-hidden />
      Run smoke test
    </Button>
  )
}

function ConnectionItem({ row, isAdmin }: { row: ConnectionView; isAdmin: boolean }) {
  const state = STATE[row.state]
  return (
    <li className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-admin-row px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-[13px] font-semibold">{row.label}</h3>
          <Badge tone={state.tone}>{state.label}</Badge>
          <span className="font-mono text-xs text-admin-subtle">{row.id}</span>
        </div>
        <DetailList items={details(row)} />
      </div>
      <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end sm:justify-start">
        <ConnectionSwitch row={row} isAdmin={isAdmin} />
        {isAdmin && row.hasSmoke && <SmokeButton row={row} />}
      </div>
    </li>
  )
}

/** A connector seeded in ConnectorState whose code isn't built yet: one short line, with the switch only if it's somehow on */
function PlannedItem({ row, isAdmin }: { row: ConnectionView; isAdmin: boolean }) {
  return (
    <li className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-admin-row px-4 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-medium">{row.label}</span>
        <span className="font-mono text-xs text-admin-subtle">{row.id}</span>
      </span>
      {row.enabled && <ConnectionSwitch row={row} isAdmin={isAdmin} />}
    </li>
  )
}

export function ConnectionsList({ rows, isAdmin }: { rows: ConnectionView[]; isAdmin: boolean }) {
  const built = rows.filter((row) => row.state !== "planned")
  const planned = rows.filter((row) => row.state === "planned")
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Services"
          description={
            isAdmin
              ? "Each one ships switched off. Switch one on after its smoke test passes; switching it off stops its sync jobs, and Jack says it isn't connected."
              : "Each one ships switched off. Only admins switch them on or off and run smoke tests."
          }
        />
        {built.length === 0 ? (
          <EmptyState title="None built yet" description="Each outside service shows its setup, last sync and smoke test here once its code lands." />
        ) : (
          <ul>
            {built.map((row) => (
              <ConnectionItem key={row.id} row={row} isAdmin={isAdmin} />
            ))}
          </ul>
        )}
      </Panel>
      {planned.length > 0 && (
        <Panel>
          <PanelHeader title="Not built yet" description="Planned services. Each shows its env vars, switch and smoke test once its code lands." />
          <ul>
            {planned.map((row) => (
              <PlannedItem key={row.id} row={row} isAdmin={isAdmin} />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}
