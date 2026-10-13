"use client"

import { useOptimistic, useState, useTransition } from "react"
import { toast } from "sonner"
import { unexpectedError } from "@/lib/action-result"
import { Badge, CellStack, DataTable, EmptyState, Notice, Segmented, UserPicker, useConfirm, type AdminUserOption, type Column } from "@/components/admin/kit"
import { updateDriverMapping } from "@/app/admin/drivers/actions"

export type DriverRow = {
  id: string
  guid: string
  /** The name the sim last reported for this GUID */
  name: string
  user: AdminUserOption | null
  /** Ingested sessions this GUID drove in */
  sessions: number
}

type View = "all" | "unmapped" | "mapped"

const RECOMPUTE_HINT = "Recompute the season's standings to update points."

export function DriversConsole({ drivers }: { drivers: DriverRow[] }) {
  const confirm = useConfirm()
  const [view, setView] = useState<View>("all")
  const [savingId, setSavingId] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  // Shows the new member right away; the action's revalidation brings the saved state back as props
  const [rows, setOptimistic] = useOptimistic(drivers, (state, change: { id: string; user: AdminUserOption | null }) =>
    state.map((driver) => (driver.id === change.id ? { ...driver, user: change.user } : driver)),
  )

  async function map(driver: DriverRow, user: AdminUserOption | null) {
    const current = driver.user
    if (current?.id === user?.id) return
    // Changing or clearing an existing mapping moves past results, so ask first
    if (current && !user) {
      const ok = await confirm({
        title: `Unmap ${driver.name}?`,
        description: `Their race results stop counting for ${current.displayName}. ${RECOMPUTE_HINT}`,
        confirmLabel: "Unmap",
        tone: "danger",
      })
      if (!ok) return
    } else if (current && user) {
      const ok = await confirm({
        title: `Map ${driver.name} to ${user.displayName}?`,
        description: `They're mapped to ${current.displayName} now. Their race results will count for ${user.displayName} instead. ${RECOMPUTE_HINT}`,
        confirmLabel: "Change mapping",
      })
      if (!ok) return
    }

    setSavingId(driver.id)
    startTransition(async () => {
      setOptimistic({ id: driver.id, user })
      try {
        await updateDriverMapping(driver.id, user?.id ?? null)
        toast.success(user ? `Mapped ${driver.name} to ${user.displayName}` : `Unmapped ${driver.name}`, { description: RECOMPUTE_HINT })
      } catch (error) {
        console.error(error)
        toast.error(unexpectedError(error, "Couldn't save the mapping"))
      } finally {
        setSavingId(null)
      }
    })
  }

  const counts = { all: rows.length, unmapped: rows.filter((d) => !d.user).length, mapped: rows.filter((d) => d.user).length }
  const visible = rows.filter((d) => (view === "all" ? true : view === "unmapped" ? !d.user : !!d.user))

  const columns: Column<DriverRow>[] = [
    {
      id: "name",
      header: "Driver",
      sortValue: (d) => d.name,
      cell: (d) => <CellStack primary={d.name} secondary={<span className="font-mono">{d.guid}</span>} />,
    },
    {
      id: "member",
      header: "Member",
      sortValue: (d) => d.user?.displayName,
      className: "w-[300px]",
      cell: (d) => (
        <UserPicker
          value={d.user}
          onChange={(user) => map(d, user)}
          placeholder="Map to a member"
          disabled={savingId === d.id}
          className="max-w-[280px]"
        />
      ),
    },
    { id: "sessions", header: "Sessions", align: "right", hideBelow: "sm", sortValue: (d) => d.sessions, cell: (d) => d.sessions },
    {
      id: "status",
      header: "Status",
      sortValue: (d) => (d.user ? 1 : 0),
      cell: (d) => (d.user ? <Badge tone="success">Mapped</Badge> : <Badge tone="warning">Unmapped</Badge>),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      {counts.unmapped > 0 && (
        <Notice tone="info">
          Drivers show up here when a results file is parsed. Unmapped drivers&apos; results don&apos;t count for any member until you map them.
        </Notice>
      )}
      <DataTable
        rows={visible}
        columns={columns}
        getRowId={(d) => d.id}
        search={{ placeholder: "Search names, GUIDs and members", text: (d) => `${d.name} ${d.guid} ${d.user?.displayName ?? ""} ${d.user?.handle ?? ""}` }}
        filters={
          <Segmented
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "unmapped", label: "Unmapped", count: counts.unmapped },
              { value: "mapped", label: "Mapped", count: counts.mapped },
            ]}
          />
        }
        // Unmapped first; the list arrives sorted by name, and the sort keeps that order within each group
        initialSort={{ id: "status" }}
        noun={{ one: "driver", many: "drivers" }}
        minWidth={640}
        empty={
          drivers.length === 0 ? (
            <EmptyState title="No drivers yet" description="Drivers appear here when a results file is parsed on the Results page." />
          ) : (
            <EmptyState title={view === "unmapped" ? "Every driver is mapped" : "No drivers here"} />
          )
        }
      />
    </div>
  )
}
