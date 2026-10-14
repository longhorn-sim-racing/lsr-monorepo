"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Download, Pencil, Plus, Ticket } from "lucide-react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  CheckboxField,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FieldGrid,
  IconButton,
  Input,
  Notice,
  PageHeader,
  RowActions,
  RowMenu,
  Segmented,
  Select,
  Textarea,
  ToneText,
  UserPicker,
  usePrompt,
  type AdminUserOption,
  type Column,
  type RowMenuItem,
  type Tone,
} from "@/components/admin/kit"
import { RacingNumber } from "@/components/racing-number"
import type { EntrantRow } from "@/server/queries/league-entrants"
import { RACING_EQUIPMENT_OPTIONS, SIM_EXPERIENCE_OPTIONS, equipmentLabel, experienceLabel } from "@/schemas/league-application.schema"
import { grantEntrantEntry, revokeEntrantEntry, saveEntrantApplication } from "@/app/admin/league-entries/actions"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { formatCents } from "@/lib/money"

type SeasonOption = { id: string; slug: string; name: string }
type StatusFilter = "all" | "paid" | "manual" | "awaiting" | "ended"
type Result = { ok: true } | { ok: false; error: string }

const STATUS: Record<EntrantRow["status"], { label: string; tone: Tone; order: number }> = {
  paid: { label: "Paid", tone: "success", order: 0 },
  manual: { label: "Entered (manual)", tone: "info", order: 1 },
  none: { label: "Awaiting payment", tone: "warning", order: 2 },
  ended: { label: "Ended", tone: "neutral", order: 3 },
}

const SOURCE_LABEL: Record<string, string> = {
  SITE: "On the site",
  ADMIN: "Added by an officer",
  GOOGLE_FORM: "Google Form",
}

const central = (iso: string) => formatInTimeZone(new Date(iso), DEFAULT_TIMEZONE, "MMM d, yyyy")
const dash = <span className="text-admin-subtle">—</span>

function matchesStatus(row: EntrantRow, filter: StatusFilter) {
  if (filter === "all") return true
  if (filter === "awaiting") return !!row.application && row.status === "none"
  return row.status === filter
}

const columns: Column<EntrantRow>[] = [
  {
    id: "driver",
    header: "Driver",
    sortValue: (r) => r.displayName,
    cell: (r) => (
      <div className="flex min-w-44 max-w-xs flex-col">
        <Link href={`/admin/users/${r.userId}/edit`} className="font-semibold hover:underline">
          {r.displayName}
        </Link>
        <span className="truncate text-xs text-admin-subtle">{r.email}</span>
        {r.application?.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">&ldquo;{r.application.notes}&rdquo;</p>}
        {r.entryNote && <p className="mt-1 text-xs text-tone-info-foreground">Entry note: {r.entryNote}</p>}
      </div>
    ),
  },
  {
    id: "number",
    header: "#",
    sortValue: (r) => r.racing.racingNumber,
    cell: (r) =>
      r.racing.racingNumber == null ? (
        dash
      ) : (
        // Drivers pick their own color (often white), so the number sits on a dark plate like on the site
        <span className="inline-flex min-w-8 justify-center rounded bg-admin-nav px-1.5 py-0.5">
          <RacingNumber user={r.racing} size="xs" />
        </span>
      ),
  },
  {
    id: "discord",
    header: "Discord",
    sortValue: (r) => r.application?.discordUsername,
    cell: (r) => r.application?.discordUsername ?? dash,
  },
  {
    id: "school",
    header: "School / EID",
    hideBelow: "md",
    cell: (r) => (
      <div className="flex flex-col">
        {r.application && <span>{r.application.school ?? "UT Austin"}</span>}
        {r.eid && <span className="font-mono text-xs text-admin-subtle">{r.eid}</span>}
        {!r.application && !r.eid && dash}
      </div>
    ),
  },
  {
    id: "experience",
    header: "Experience",
    hideBelow: "lg",
    cell: (r) => (r.application ? <span className="block min-w-36 max-w-52 text-muted-foreground">{experienceLabel(r.application.experience)}</span> : dash),
  },
  {
    id: "equipment",
    header: "Equipment",
    hideBelow: "lg",
    cell: (r) =>
      r.application ? (
        <div className="flex min-w-28 flex-col">
          <span className="text-muted-foreground">{r.application.equipment.map(equipmentLabel).join(", ")}</span>
          {!r.application.canCommit && <ToneText tone="warning">Can&apos;t commit to schedule</ToneText>}
        </div>
      ) : (
        dash
      ),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (r) => STATUS[r.status].order,
    cell: (r) => (
      <div className="flex flex-col items-start gap-0.5">
        {r.status === "none" && !r.application ? <Badge>No entry</Badge> : <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>}
        {r.status === "paid" && r.paidCents !== null && (
          <span className="text-xs text-admin-subtle">
            {formatCents(r.paidCents)}
            {r.returningRate && " · returning rate"}
          </span>
        )}
        {r.paidAt && r.status !== "none" && <span className="whitespace-nowrap text-xs text-admin-subtle">{central(r.paidAt)}</span>}
      </div>
    ),
  },
  {
    id: "form",
    header: "Entry form",
    hideBelow: "md",
    sortValue: (r) => r.application?.createdAt,
    cell: (r) =>
      r.application ? (
        <div className="flex flex-col whitespace-nowrap">
          <span>{central(r.application.createdAt)}</span>
          <span className="text-xs text-admin-subtle">{SOURCE_LABEL[r.application.source] ?? r.application.source}</span>
        </div>
      ) : (
        <ToneText>None</ToneText>
      ),
  },
]

export function LeagueEntriesConsole({
  seasons,
  season,
  isOpenSeason,
  rows,
}: {
  seasons: SeasonOption[]
  season: SeasonOption
  isOpenSeason: boolean
  rows: EntrantRow[]
}) {
  const router = useRouter()
  const prompt = usePrompt()
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [editing, setEditing] = useState<EntrantRow | "new" | null>(null)
  const [pending, startTransition] = useTransition()

  const counts = useMemo(
    () => ({
      forms: rows.filter((r) => r.application).length,
      paid: rows.filter((r) => r.status === "paid").length,
      manual: rows.filter((r) => r.status === "manual").length,
      awaiting: rows.filter((r) => matchesStatus(r, "awaiting")).length,
      ended: rows.filter((r) => r.status === "ended").length,
    }),
    [rows],
  )

  const visible = useMemo(() => rows.filter((r) => matchesStatus(r, filter)), [rows, filter])

  function run(action: () => Promise<Result>, success: string) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(success)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  async function grant(r: EntrantRow) {
    const note = await prompt({
      title: `Enter ${r.displayName} without a Stripe payment?`,
      description: "For drivers who paid another way or are comped. They count as entered right away.",
      inputLabel: "Note (optional)",
      placeholder: 'e.g. "paid cash"',
      confirmLabel: "Enter driver",
    })
    if (note !== null) run(() => grantEntrantEntry(r.userId, season.id, note), "Driver entered")
  }

  const canGrant = (r: EntrantRow) => isOpenSeason && (r.status === "none" || r.status === "ended")

  return (
    <>
      <PageHeader
        title="LSC entries"
        description={`${season.name} · ${counts.forms} entry ${counts.forms === 1 ? "form" : "forms"} · ${counts.paid + counts.manual} entered`}
        actions={
          <>
            <Select
              aria-label="Season"
              value={season.slug}
              onChange={(e) => router.push(`/admin/league-entries?season=${e.target.value}`)}
              className="w-auto max-w-56"
            >
              {seasons.map((s) => (
                <option key={s.id} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Button asChild>
              <a href={`/admin/league-entries/export?season=${season.slug}`}>
                <Download aria-hidden />
                CSV
              </a>
            </Button>
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              Add entrant
            </Button>
          </>
        }
      />

      {!isOpenSeason && (
        <Notice tone="info" className="mb-3">
          This is a past season. You can still fix entry forms, but entering drivers by hand only works for the open season.
        </Notice>
      )}

      <DataTable
        rows={visible}
        columns={columns}
        getRowId={(r) => r.userId}
        search={{
          placeholder: "Search name, email, EID or Discord",
          text: (r) => [r.displayName, r.handle, r.email, r.eid, r.application?.discordUsername, r.application?.school].filter(Boolean).join(" "),
        }}
        filters={
          <Segmented
            label="Entry status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: rows.length },
              { value: "paid", label: "Paid", count: counts.paid },
              { value: "manual", label: "Manual", count: counts.manual },
              { value: "awaiting", label: "Awaiting payment", count: counts.awaiting },
              { value: "ended", label: "Ended", count: counts.ended },
            ]}
          />
        }
        rowActions={(r) => {
          const items: RowMenuItem[] = []
          if (r.status === "manual" && r.entryId) {
            const entryId = r.entryId
            items.push(
              {
                label: "End manual entry",
                disabled: pending,
                destructive: {
                  title: `End ${r.displayName}'s manual entry?`,
                  description: "They'll no longer count as entered. You can enter them again later.",
                  confirmLabel: "End entry",
                },
                onSelect: () => run(() => revokeEntrantEntry(entryId), "Entry ended"),
              },
              "separator",
            )
          }
          items.push({ label: "Member page", href: `/admin/users/${r.userId}/edit` }, { label: "Public profile", href: `/drivers/${r.handle}`, external: true })
          return (
            <RowActions>
              {canGrant(r) && (
                <IconButton label={`Enter ${r.displayName} manually (paid outside Stripe)`} disabled={pending} onClick={() => grant(r)}>
                  <Ticket />
                </IconButton>
              )}
              <IconButton label={`Edit ${r.displayName}'s entry form`} onClick={() => setEditing(r)}>
                <Pencil />
              </IconButton>
              <RowMenu label={`More actions for ${r.displayName}`} items={items} />
            </RowActions>
          )
        }}
        onRowClick={(r) => setEditing(r)}
        noun={{ one: "entrant", many: "entrants" }}
        minWidth={720}
        empty={
          rows.length > 0 ? (
            <EmptyState title="No entrants with this status" description="Pick another status above to see the rest." />
          ) : (
            <EmptyState
              title="No entrants yet"
              description="Drivers show up here when they fill out the entry form or get entered."
              action={<Button onClick={() => setEditing("new")}>Add entrant</Button>}
            />
          )
        }
      />

      <EntrantDialog
        key={editing === "new" ? "new" : (editing?.userId ?? "closed")}
        entrant={editing}
        season={season}
        canGrant={isOpenSeason}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          router.refresh()
        }}
      />
    </>
  )
}

function EntrantDialog({
  entrant,
  season,
  canGrant,
  onClose,
  onSaved,
}: {
  entrant: EntrantRow | "new" | null
  season: SeasonOption
  canGrant: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const existing = entrant && entrant !== "new" ? entrant : null
  const app = existing?.application
  const [picked, setPicked] = useState<AdminUserOption | null>(null)
  const userId = existing?.userId ?? picked?.id ?? null
  const [form, setForm] = useState({
    discordUsername: app?.discordUsername ?? "",
    experience: app?.experience ?? "SIM_RACER",
    equipment: app?.equipment ?? ["WHEEL", "PEDALS"],
    canCommit: app?.canCommit ?? true,
    utStudent: app ? app.school === null : true,
    eid: existing?.eid ?? "",
    school: app?.school ?? "",
    notes: app?.notes ?? "",
  })
  const [alsoEnter, setAlsoEnter] = useState(false)
  const [entryNote, setEntryNote] = useState("")
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!userId) return toast.error("Pick a driver first.")
    setSaving(true)
    const result = await saveEntrantApplication(userId, season.id, form)
    if (result.ok && alsoEnter) {
      const granted = await grantEntrantEntry(userId, season.id, entryNote)
      if (!granted.ok) toast.error(`Form saved, but entry failed: ${granted.error}`)
    }
    setSaving(false)
    if (!result.ok) return toast.error(result.error)
    toast.success("Entry form saved")
    onSaved()
  }

  const toggleEquipment = (value: string, on: boolean) =>
    setForm((f) => ({ ...f, equipment: on ? [...f.equipment, value] : f.equipment.filter((e) => e !== value) }))

  const showAlsoEnter = canGrant && (!existing || existing.status === "none" || existing.status === "ended")

  return (
    <Dialog
      open={entrant !== null}
      onOpenChange={(open) => !open && onClose()}
      title={existing ? `Entry form: ${existing.displayName}` : "Add entrant"}
      description={season.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={saving} disabled={!userId} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!existing && (
          <Field label="Driver" htmlFor="entrant-driver" hint="They need a site account. Search by name, handle, email or EID." required>
            <UserPicker
              id="entrant-driver"
              value={picked}
              onChange={(user) => {
                setPicked(user)
                if (user?.eid) setForm((f) => ({ ...f, eid: user.eid ?? f.eid }))
              }}
              placeholder="Find a member"
            />
          </Field>
        )}

        <FieldGrid>
          <Field label="Discord username" htmlFor="entrant-discord" required>
            <Input id="entrant-discord" value={form.discordUsername} onChange={(e) => setForm({ ...form, discordUsername: e.target.value })} />
          </Field>
          <Field label="Experience" htmlFor="entrant-experience">
            <Select id="entrant-experience" value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })}>
              {SIM_EXPERIENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGrid>

        <div className="flex flex-col gap-2">
          <CheckboxField id="entrant-ut" label="UT Austin student" checked={form.utStudent} onChange={(e) => setForm({ ...form, utStudent: e.target.checked })} />
          {form.utStudent ? (
            <Field label="UT EID" htmlFor="entrant-eid" hint="Optional">
              <Input id="entrant-eid" value={form.eid} onChange={(e) => setForm({ ...form, eid: e.target.value })} />
            </Field>
          ) : (
            <Field label="School or affiliation" htmlFor="entrant-school" hint="Optional">
              <Input id="entrant-school" value={form.school} onChange={(e) => setForm({ ...form, school: e.target.value })} />
            </Field>
          )}
        </div>

        <Field label="Equipment">
          <div className="grid grid-cols-2 gap-2">
            {RACING_EQUIPMENT_OPTIONS.map((o) => (
              <CheckboxField
                key={o.value}
                id={`entrant-eq-${o.value}`}
                label={o.label}
                checked={form.equipment.includes(o.value)}
                onChange={(e) => toggleEquipment(o.value, e.target.checked)}
              />
            ))}
          </div>
        </Field>

        <CheckboxField
          id="entrant-commit"
          label="Can commit to weekday practice and Saturday races"
          checked={form.canCommit}
          onChange={(e) => setForm({ ...form, canCommit: e.target.checked })}
        />

        <Field label="Notes or questions" htmlFor="entrant-notes" hint="Optional">
          <Textarea id="entrant-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>

        {showAlsoEnter && (
          <div className="flex flex-col gap-2.5 rounded-md border bg-admin-surface p-3">
            <CheckboxField
              id="entrant-enter"
              label="Also enter them now"
              description="For drivers who paid outside Stripe or are comped."
              checked={alsoEnter}
              onChange={(e) => setAlsoEnter(e.target.checked)}
            />
            {alsoEnter && (
              <Field label="Entry note" htmlFor="entrant-entry-note" hint="Optional">
                <Input id="entrant-entry-note" value={entryNote} onChange={(e) => setEntryNote(e.target.value)} placeholder='e.g. "paid Venmo 9/20"' />
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
