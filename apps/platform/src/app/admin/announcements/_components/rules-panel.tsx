"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { toast } from "sonner"
import { Badge, Button, CheckboxField, Dialog, EmptyState, Field, FieldGrid, Input, Panel, PanelHeader, RowActions, RowMenu, Select, SwitchField, useConfirm, type RowMenuItem } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import type { RuleView } from "@/server/discord-post/queries"
import { createRuleAction, deleteRuleAction, setRuleEnabledAction, updateRuleAction, type RuleFormInput } from "../actions"
import type { ChannelOption } from "./compose"

export type RoleOption = { id: string; name: string }
export type SeriesOption = { value: string; label: string }

/** What each kind of rule does, for the form (the server's RULE_INFO says the same) */
const KINDS: { value: string; label: string; description: string; posts: boolean }[] = [
  { value: "event_reminder", label: "Event reminders", description: "Reminds the channel before each public event starts.", posts: true },
  { value: "new_event", label: "New events", description: "Announces each upcoming event once it's public on the site.", posts: true },
  { value: "results_posted", label: "Results posted", description: "Posts a race's top three once its results are uploaded.", posts: true },
  { value: "standings_update", label: "Standings updates", description: "Posts the Lone Star Cup's top drivers when its standings are recomputed.", posts: true },
  { value: "twitch_live", label: "Twitch live", description: "Says when the club's Twitch channel goes live.", posts: true },
  { value: "event_mirror", label: "Event mirror", description: "Adds each upcoming public event to the server's Events list and keeps it up to date (shown on Community → Discord).", posts: false },
]

const OFFSETS = [
  { value: 10_080, label: "1 week before" },
  { value: 4_320, label: "3 days before" },
  { value: 1_440, label: "1 day before" },
  { value: 180, label: "3 hours before" },
  { value: 60, label: "1 hour before" },
  { value: 30, label: "30 minutes before" },
]

async function run(action: () => Promise<ActionResult>, what: string): Promise<boolean> {
  let result: ActionResult
  try {
    result = await action()
  } catch (error) {
    result = { ok: false, error: unexpectedError(error, what) }
  }
  if (!result.ok) toast.error(result.error)
  return result.ok
}

type FormState = { kind: string; channelId: string; offsets: number[]; series: string; top: number; pingRoleId: string; location: string; enabled: boolean }

function RuleDialog({ rule, channels, roles, series, onClose }: { rule: RuleView | null; channels: ChannelOption[]; roles: RoleOption[]; series: SeriesOption[]; onClose: () => void }) {
  const router = useRouter()
  const [form, setForm] = useState<FormState>({
    kind: rule?.kind ?? "event_reminder",
    channelId: rule?.channelId ?? channels[0]?.id ?? "",
    offsets: rule?.config.offsets.length ? rule.config.offsets : [1_440, 60],
    series: rule?.config.series ?? "",
    top: rule?.config.top ?? 5,
    pingRoleId: rule?.config.pingRoleId ?? "",
    location: rule?.config.location ?? "",
    enabled: true,
  })
  const [saving, setSaving] = useState(false)
  const kind = KINDS.find((k) => k.value === form.kind)!
  // A rule's saved ping stays pickable even when Discord can't be read right now
  const roleOptions = rule?.config.pingRoleId && !roles.some((r) => r.id === rule.config.pingRoleId) ? [...roles, { id: rule.config.pingRoleId, name: rule.config.pingName ?? "Saved role" }] : roles
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const toggleOffset = (value: number, on: boolean) => set("offsets", on ? [...form.offsets, value].sort((a, b) => b - a) : form.offsets.filter((o) => o !== value))

  async function save() {
    const input: RuleFormInput = {
      kind: form.kind,
      channelId: kind.posts ? form.channelId : null,
      offsets: form.kind === "event_reminder" ? form.offsets : undefined,
      series: form.series || null,
      top: form.kind === "standings_update" ? form.top : null,
      pingRoleId: kind.posts ? form.pingRoleId || null : null,
      location: form.kind === "event_mirror" ? form.location || null : null,
    }
    setSaving(true)
    const ok = await run(() => (rule ? updateRuleAction(rule.id, input) : createRuleAction(input, form.enabled)), "Couldn't save the rule")
    setSaving(false)
    if (!ok) return
    toast.success(rule ? "Rule saved" : form.enabled ? "Rule set up and switched on" : "Rule set up (off)")
    onClose()
    router.refresh()
  }

  const offsetsBad = form.kind === "event_reminder" && (form.offsets.length < 1 || form.offsets.length > 3)
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={rule ? `Edit “${rule.label}”` : "New standing rule"}
      description="Rules post a fixed template from the site's data, only about public events, and only about what happens after they're switched on."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={saving} disabled={offsetsBad || (kind.posts && !form.channelId)} onClick={() => void save()}>
            {rule ? "Save" : "Set up rule"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Kind" htmlFor="rule-kind" hint={kind.description}>
          <Select id="rule-kind" value={form.kind} disabled={Boolean(rule)} onChange={(e) => set("kind", e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        {kind.posts && (
          <FieldGrid>
            <Field label="Channel" htmlFor="rule-channel" required>
              <Select id="rule-channel" value={form.channelId} onChange={(e) => set("channelId", e.target.value)}>
                {!channels.length && <option value="">No posting channels yet</option>}
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ping" htmlFor="rule-ping" hint={roleOptions.length ? "A role only; rules never ping @everyone." : "No pingable roles (or Discord isn't connected)."}>
              <Select id="rule-ping" value={form.pingRoleId} onChange={(e) => set("pingRoleId", e.target.value)}>
                <option value="">Nobody</option>
                {roleOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    @{r.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGrid>
        )}
        {form.kind === "event_reminder" && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-tone-neutral-foreground">When (pick 1 to 3)</legend>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {OFFSETS.map((o) => (
                <CheckboxField key={o.value} label={o.label} checked={form.offsets.includes(o.value)} onChange={(e) => toggleOffset(o.value, e.target.checked)} />
              ))}
            </div>
            {offsetsBad && <p className="text-xs font-medium text-tone-danger-foreground">Pick one to three times.</p>}
          </fieldset>
        )}
        {["event_reminder", "new_event", "results_posted", "event_mirror"].includes(form.kind) && (
          <Field label="Events" htmlFor="rule-series" hint="Every public event, or one series' only.">
            <Select id="rule-series" value={form.series} onChange={(e) => set("series", e.target.value)}>
              <option value="">Every public event</option>
              {series.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {form.kind === "standings_update" && (
          <Field label="Drivers listed" htmlFor="rule-top">
            <Select id="rule-top" value={form.top} onChange={(e) => set("top", Number(e.target.value))}>
              {[3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  Top {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {form.kind === "event_mirror" && (
          <Field label="Location for events with no venue" htmlFor="rule-location" hint="Discord needs a location. Events with a venue show it; a meeting link is never shown.">
            <Input id="rule-location" value={form.location} maxLength={100} placeholder="See the event page on longhornsimracing.org" onChange={(e) => set("location", e.target.value)} />
          </Field>
        )}
        {!rule && <SwitchField label="Switch it on now" description="It acts only on what happens from then on." checked={form.enabled} onCheckedChange={(on) => set("enabled", on)} />}
      </div>
    </Dialog>
  )
}

/** Standing rules: officers see them and can pause one; admins set them up, change and switch them on */
export function RulesPanel({ rules, isAdmin, channels, roles, series }: { rules: RuleView[]; isAdmin: boolean; channels: ChannelOption[]; roles: RoleOption[]; series: SeriesOption[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<RuleView | "new" | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function toggle(rule: RuleView, on: boolean) {
    if (on) {
      const ok = await confirm({ title: `Switch on “${rule.label}”?`, description: `${rule.description}. It posts by itself from now on, about what happens from now on.`, confirmLabel: "Switch on" })
      if (!ok) return
    }
    setBusy(rule.id)
    const ok = await run(() => setRuleEnabledAction(rule.id, on), "Couldn't switch it")
    setBusy(null)
    if (!ok) return
    toast.success(on ? "Switched on" : "Paused; its scheduled posts are cancelled")
    router.refresh()
  }

  async function remove(rule: RuleView) {
    const ok = await run(() => deleteRuleAction(rule.id), "Couldn't delete it")
    if (!ok) return
    toast.success("Rule deleted")
    router.refresh()
  }

  return (
    <Panel>
      <PanelHeader
        title="Standing rules"
        description={isAdmin ? "Automations that post fixed templates over the site's data. Admins set them up and switch them on; any officer can pause one." : "Automations that post fixed templates over the site's data. Admins set them up; any officer can pause one."}
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              New rule
            </Button>
          ) : undefined
        }
      />
      {rules.length ? (
        <ul className="flex flex-col">
          {rules.map((rule) => {
            const menu: RowMenuItem[] = isAdmin
              ? [
                  { label: "Edit", onSelect: () => setEditing(rule) },
                  { label: "Delete", onSelect: () => remove(rule), destructive: { title: `Delete “${rule.label}”?`, description: "Its scheduled posts are cancelled. What it already posted stays in Discord.", confirmLabel: "Delete rule", tone: "danger" } },
                ]
              : []
            return (
              <li key={rule.id} className="flex items-start gap-3 border-b border-admin-row px-4 py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{rule.label}</span>
                    <Badge tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "On" : "Off"}</Badge>
                    {rule.scheduled > 0 && <Badge tone="info">{rule.scheduled} scheduled</Badge>}
                  </div>
                  <p className="break-words text-xs text-muted-foreground">{rule.description}</p>
                  <p className="text-xs text-admin-subtle">{[rule.enabled ? rule.since : null, rule.lastPost].filter(Boolean).join(" · ") || "Hasn't posted yet"}</p>
                </div>
                <RowActions>
                  <SwitchPrimitive.Root
                    aria-label={rule.enabled ? `Pause ${rule.label}` : `Switch on ${rule.label}`}
                    checked={rule.enabled}
                    disabled={busy === rule.id || (!rule.enabled && !isAdmin)}
                    onCheckedChange={(on) => void toggle(rule, on)}
                    className="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-input outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary"
                  >
                    <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[16px]" />
                  </SwitchPrimitive.Root>
                  {menu.length > 0 && <RowMenu label={`Options for ${rule.label}`} items={menu} />}
                </RowActions>
              </li>
            )
          })}
        </ul>
      ) : (
        <EmptyState
          title="No standing rules yet"
          description={isAdmin ? "Set up event reminders, new-event announcements, results, standings, Twitch live posts or the event mirror. Jack can propose one too." : "An admin sets these up (Jack can propose one)."}
        />
      )}
      {editing && <RuleDialog rule={editing === "new" ? null : editing} channels={channels} roles={roles} series={series} onClose={() => setEditing(null)} />}
    </Panel>
  )
}
