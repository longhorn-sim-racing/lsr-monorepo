"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button, Field, FieldGrid, FormActions, Input, Notice, Select, SwitchField } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { clockLabel, WEEKDAY_LABEL, WEEKDAYS, type DigestSettingsInput, type Weekday } from "@/lib/jack/recurring"
import { saveDigestSettingsAction } from "../actions"
import type { RoomChoice } from "./questions"

/** The digest's settings and state, as the page shows them */
export type DigestFormView = DigestSettingsInput & {
  /** "Mondays at 9:00 AM CT" */
  scheduleText: string
  nextRun: string | null
  lastRun: { at: string; status: string | null } | null
  /** The last digest posted in a room */
  lastNote: { href: string; at: string } | null
  /** "Gray, Mon, Oct 26, 9:00 AM CT": who saved the settings last, and when */
  configured: string | null
  discordChannels: { id: string; name: string }[]
  discordConnected: boolean
  teamsState: "connected" | "off" | "not_configured" | "error"
  teamsHost: string | null
}

const TEAMS_STATE: Record<DigestFormView["teamsState"], string> = {
  connected: "Teams posting is connected",
  off: "Teams posting is switched off on System → Connections",
  not_configured: "Teams posting isn't set up (TEAMS_WEBHOOK_URL, System → Connections)",
  error: "Teams posting is failing (System → Connections)",
}

/** The weekly digest's settings: any officer sets the room, day, time and summary; an admin sets Discord and Teams */
export function DigestForm({ view, rooms, isAdmin }: { view: DigestFormView; rooms: RoomChoice[]; isAdmin: boolean }) {
  const router = useRouter()
  const [form, setForm] = useState<DigestSettingsInput>({
    enabled: view.enabled,
    roomId: view.roomId,
    day: view.day,
    time: view.time,
    summary: view.summary,
    discordChannelId: view.discordChannelId,
    teams: view.teams,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof DigestSettingsInput>(key: K, value: DigestSettingsInput[K]) => setForm((f) => ({ ...f, [key]: value }))
  // The saved room stays pickable even if it was archived since (saving then asks for another)
  const roomChoices = view.roomId && !rooms.some((r) => r.id === view.roomId) ? [{ id: view.roomId, title: "(its room, now archived or gone)" }, ...rooms] : rooms
  const channels = view.discordChannelId && !view.discordChannels.some((c) => c.id === view.discordChannelId) ? [{ id: view.discordChannelId, name: "(its channel, no longer synced)" }, ...view.discordChannels] : view.discordChannels

  async function save() {
    setSaving(true)
    setError(null)
    let result: ActionResult
    try {
      result = await saveDigestSettingsAction(form)
    } catch (thrown) {
      result = { ok: false, error: unexpectedError(thrown, "Couldn't save the digest's settings") }
    }
    setSaving(false)
    if (!result.ok) return setError(result.error)
    toast.success(form.enabled ? "Saved: the digest is on" : "Saved")
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3.5">
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-admin-subtle">When</dt>
        <dd>
          {view.scheduleText}
          {view.nextRun ? ` · next ${view.nextRun}` : view.enabled ? "" : " · off"}
        </dd>
        <dt className="text-admin-subtle">Last run</dt>
        <dd>
          {view.lastRun ? `${view.lastRun.at}${view.lastRun.status ? ` (${view.lastRun.status === "ok" ? "ran" : view.lastRun.status})` : ""}` : "Never"}
          {view.lastNote ? (
            <>
              {" · "}
              <Link href={view.lastNote.href} className="font-medium text-foreground hover:underline">
                last digest in its room
              </Link>
            </>
          ) : null}
        </dd>
        <dt className="text-admin-subtle">Set up by</dt>
        <dd>{view.configured ?? "Nobody yet"}</dd>
      </dl>

      {error ? (
        <Notice tone="danger" className="py-2">
          {error}
        </Notice>
      ) : null}

      <SwitchField
        label="Post the weekly digest"
        description="Off until an officer turns it on. Saving records you as the one who set it up; Jack's summary is written as you."
        checked={form.enabled}
        onCheckedChange={(checked) => set("enabled", checked)}
      />
      <FieldGrid>
        <Field label="Room" htmlFor="digest-room" hint="Gets the full list, linking each item">
          <Select id="digest-room" value={form.roomId} onChange={(e) => set("roomId", e.target.value)}>
            <option value="">Pick a room</option>
            {roomChoices.map((room) => (
              <option key={room.id} value={room.id}>
                {room.title}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day" htmlFor="digest-day">
            <Select id="digest-day" value={form.day} onChange={(e) => set("day", e.target.value as Weekday)}>
              {WEEKDAYS.map((day) => (
                <option key={day} value={day}>
                  {WEEKDAY_LABEL[day]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time (Central)" htmlFor="digest-time" hint={form.time ? clockLabel(form.time) : undefined}>
            <Input id="digest-time" type="time" step={60} value={form.time} onChange={(e) => set("time", e.target.value)} />
          </Field>
        </div>
      </FieldGrid>
      <SwitchField
        label="Jack sums it up in the room"
        description="A few sentences on what needs attention first, from the list only. It counts toward automations' monthly cap (about a cent to a dime a week)."
        checked={form.summary}
        onCheckedChange={(checked) => set("summary", checked)}
      />

      <fieldset className="flex flex-col gap-3 rounded-md border border-admin-row p-3">
        <legend className="px-1 text-xs font-bold">Outside the console {isAdmin ? "" : "(admins set these)"}</legend>
        <p className="text-xs text-admin-subtle">Discord and Teams get each check&apos;s name, its count and a link into the console: never names, items or anything an officer wrote. Nobody is pinged.</p>
        <Field
          label="Discord channel"
          htmlFor="digest-discord"
          hint={view.discordConnected ? "A text or announcement channel the server sync knows" : "Discord isn't connected: the digest skips it until it is (System → Connections)"}
        >
          <Select id="digest-discord" value={form.discordChannelId} disabled={!isAdmin} onChange={(e) => set("discordChannelId", e.target.value)}>
            <option value="">Don&apos;t post to Discord</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </Select>
        </Field>
        <SwitchField
          label="Post to Teams"
          description={`${TEAMS_STATE[view.teamsState]}${view.teamsHost ? ` (through ${view.teamsHost})` : ""}.`}
          checked={form.teams}
          disabled={!isAdmin}
          onCheckedChange={(checked) => set("teams", checked)}
        />
      </fieldset>

      <FormActions note="Changes apply from the next run.">
        <Button variant="primary" pending={saving} onClick={() => void save()}>
          Save
        </Button>
      </FormActions>
    </div>
  )
}
