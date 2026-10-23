"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { toast } from "sonner"
import { Badge, Button, Dialog, EmptyState, Field, Panel, PanelHeader, RowActions, RowMenu, Select, SwitchField, useConfirm } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import type { RoleSyncView } from "@/server/discord-post/queries"
import { createRoleRuleAction, deleteRoleRuleAction, setRoleRuleEnabledAction } from "./actions"

export type ConditionOption = { value: string; label: string; description: string }

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

function AddRuleDialog({ roles, conditions, onClose }: { roles: { id: string; name: string }[]; conditions: ConditionOption[]; onClose: () => void }) {
  const router = useRouter()
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "")
  const [condition, setCondition] = useState(conditions[0]?.value ?? "")
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const picked = conditions.find((c) => c.value === condition)

  async function save() {
    setSaving(true)
    const ok = await run(() => createRoleRuleAction({ roleId, condition, enabled }), "Couldn't add the rule")
    setSaving(false)
    if (!ok) return
    toast.success("Role sync rule added")
    onClose()
    router.refresh()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New role sync rule"
      description="Linked members get the role while they meet the condition, and lose it when they stop, unlink their account, delete it, or have their Discord data deleted. Members who never linked their account are never touched."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={saving} disabled={!roleId || !condition} onClick={() => void save()}>
            Add rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Discord role" htmlFor="sync-role" hint="Only plain roles below the bot's own. Not listed: roles with moderation permissions (server-wide, or in a channel through its permission overrides) and roles with Create Events or Create Expressions that @everyone doesn't have. Overrides in channels the bot can't see can't be checked.">
          <Select id="sync-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                @{r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who gets it" htmlFor="sync-condition" hint={picked?.description}>
          <Select id="sync-condition" value={condition} onChange={(e) => setCondition(e.target.value)}>
            {conditions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <SwitchField label="Switch it on now" description="The next hourly run makes the changes; each one is in the audit log." checked={enabled} onCheckedChange={setEnabled} />
      </div>
    </Dialog>
  )
}

/** Role sync rules (design §12.1): which Discord role linked members get, and when. Admins change them */
export function RoleSyncPanel({ view, conditions, isAdmin }: { view: RoleSyncView; conditions: ConditionOption[]; isAdmin: boolean }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  async function toggle(id: string, name: string, on: boolean) {
    if (on) {
      const ok = await confirm({ title: `Switch on role sync for ${name}?`, description: "From the next hourly run, linked members who meet the condition get the role and those who don't lose it.", confirmLabel: "Switch on" })
      if (!ok) return
    }
    setBusy(id)
    const ok = await run(() => setRoleRuleEnabledAction(id, on), "Couldn't switch it")
    setBusy(null)
    if (!ok) return
    toast.success(on ? "Switched on" : "Switched off")
    router.refresh()
  }

  async function remove(id: string) {
    const ok = await run(() => deleteRoleRuleAction(id), "Couldn't delete it")
    if (!ok) return
    toast.success("Rule deleted")
    router.refresh()
  }

  const lastRun = view.lastRun ? `Last run ${view.lastRun.at}${view.lastRun.summary ? `: ${view.lastRun.summary}` : ""}` : "Hasn't run yet (Scheduled jobs → discord.role-sync)"
  const waiting = view.waitingTakeBacks
    ? ` ${view.waitingTakeBacks} unlinked ${view.waitingTakeBacks === 1 ? "account still has its" : "accounts still have their"} roles: the next run takes them back (Discord couldn't be reached when they unlinked).`
    : ""
  return (
    <Panel>
      <PanelHeader
        title="Role sync"
        description={`Discord roles for the ${view.linked} linked ${view.linked === 1 ? "member" : "members"}, kept in step hourly, and taken back when a member unlinks, deletes their account or has their Discord data deleted.${waiting} ${lastRun}.`}
        actions={
          isAdmin ? (
            <Button size="sm" disabled={!view.safeRoles.length} onClick={() => setAdding(true)} title={view.live ? undefined : "Discord isn't connected"}>
              New rule
            </Button>
          ) : undefined
        }
      />
      {view.rules.length ? (
        <ul className="flex flex-col">
          {view.rules.map((rule) => {
            const name = rule.roleName ? `@${rule.roleName}` : "a role Discord didn't name"
            return (
              <li key={rule.id} className="flex items-start gap-3 border-b border-admin-row px-4 py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{name}</span>
                    <Badge tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "On" : "Off"}</Badge>
                    {rule.refusal && <Badge tone="danger">Refused</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    For {rule.conditionLabel.toLowerCase()}: {rule.qualifying === null ? "can't tell who right now" : `${rule.qualifying} qualify`}, {rule.holders} hold it
                    {rule.others > 0 && `, and ${rule.others} who ${rule.others === 1 ? "isn't" : "aren't"} linked (given in Discord; role sync leaves them alone)`}
                  </p>
                  {rule.refusal && <p className="text-xs text-tone-danger-foreground">{rule.refusal}</p>}
                </div>
                {isAdmin && (
                  <RowActions>
                    <SwitchPrimitive.Root
                      aria-label={`${rule.enabled ? "Switch off" : "Switch on"} role sync for ${name}`}
                      checked={rule.enabled}
                      disabled={busy === rule.id}
                      onCheckedChange={(on) => void toggle(rule.id, name, on)}
                      className="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-input outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary"
                    >
                      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[16px]" />
                    </SwitchPrimitive.Root>
                    <RowMenu
                      label={`Options for ${name}`}
                      items={[{ label: "Delete", onSelect: () => remove(rule.id), destructive: { title: `Delete role sync for ${name}?`, description: "Members keep the role they have now; nobody gets or loses it through this rule again.", confirmLabel: "Delete", tone: "danger" } }]}
                    />
                  </RowActions>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <EmptyState title="No role sync rules" description={isAdmin ? (view.live ? "Add one to give linked members a Discord role, like LSC Driver for entered drivers." : "Discord isn't connected, so its roles can't be read.") : "An admin sets these up."} />
      )}
      {adding && <AddRuleDialog roles={view.safeRoles} conditions={conditions} onClose={() => setAdding(false)} />}
    </Panel>
  )
}
