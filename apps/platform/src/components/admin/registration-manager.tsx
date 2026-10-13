"use client"

import { useState } from "react"
import type { RegistrationStatus } from "@prisma/client"
import { GripVertical } from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  Badge,
  Button,
  CellStack,
  DataTable,
  EmptyState,
  RowActions,
  RowMenu,
  TD,
  TH,
  THead,
  TR,
  Table,
  useConfirm,
  type Column,
} from "@/components/admin/kit"
import { overrideRegistrationStatus, removeRegistration, reorderWaitlist } from "@/app/admin/events/actions"
import { useAction } from "@/app/admin/events/_components/use-action"
import { centralDateTime } from "@/app/admin/events/_components/format"
import { cn } from "@/lib/utils"

/** One registration on the manage page, any status. */
export type RegistrationRow = {
  id: string
  userId: string
  displayName: string
  handle: string
  status: RegistrationStatus
  waitlistOrder: number | null
  /** "AUTO" or "ADMIN" once someone moved up from the waitlist */
  promotionSource: string | null
  /** Registered through a Stripe payment */
  paid: boolean
  createdAt: Date
  updatedAt: Date
}

function Section({ title, count, hint, children }: { title: string; count: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs tabular-nums text-admin-subtle">{count}</span>
        {hint && <span className="text-xs text-admin-subtle">· {hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Source({ row }: { row: RegistrationRow }) {
  return (
    <span className="flex flex-wrap gap-1">
      {row.paid && <Badge tone="success">Paid</Badge>}
      {row.promotionSource === "AUTO" && <Badge>Moved up automatically</Badge>}
      {row.promotionSource === "ADMIN" && <Badge tone="accent">Promoted by an officer</Badge>}
      {!row.paid && !row.promotionSource && <span className="text-admin-subtle">Signed up</span>}
    </span>
  )
}

/** A waitlist row that can be dragged by its handle (or moved with the keyboard: focus the handle, space, arrows). */
function SortableRow({ id, position, children }: { id: string; position: number; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <TR
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("bg-card", isDragging && "relative z-10 shadow-md")}
    >
      <TD className="w-px px-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="flex size-7 cursor-grab touch-none items-center justify-center rounded-md text-admin-subtle hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
          aria-label={`Move position ${position}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      </TD>
      <TD className="w-px text-right text-admin-subtle">{position}</TD>
      {children}
    </TR>
  )
}

export function RegistrationManager({
  eventId,
  registrations,
  registrationMax,
  isPaid,
}: {
  eventId: string
  registrations: RegistrationRow[]
  registrationMax: number | null
  isPaid: boolean
}) {
  const confirm = useConfirm()
  const { run, busyKey } = useAction()

  const registered = registrations.filter((r) => r.status === "REGISTERED")
  const waitlisted = registrations
    .filter((r) => r.status === "WAITLISTED")
    .sort((a, b) => (a.waitlistOrder ?? 0) - (b.waitlistOrder ?? 0))
  const notAttending = registrations.filter((r) => r.status === "NOT_ATTENDING")
  const full = registrationMax != null && registered.length >= registrationMax

  // The waitlist order as last shown. Dragging changes it right away; when the server sends a different
  // order (a save, someone joining or leaving, the live refresh), that wins.
  const serverOrder = waitlisted.map((r) => r.id)
  const serverKey = serverOrder.join(",")
  const [order, setOrder] = useState(serverOrder)
  const [syncedKey, setSyncedKey] = useState(serverKey)
  if (serverKey !== syncedKey) {
    setSyncedKey(serverKey)
    setOrder(serverOrder)
  }
  const byId = new Map(waitlisted.map((r) => [r.id, r]))
  const waitlistRows = order.map((id) => byId.get(id)).filter((r): r is RegistrationRow => r != null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))
    setOrder(next)
    const ok = await run(() => reorderWaitlist(eventId, next), { success: "Waitlist order saved", error: "Couldn't save the new order" }, "reorder")
    if (!ok) setOrder(serverOrder)
  }

  const setStatus = (row: RegistrationRow, status: RegistrationStatus, reason: string, success: string) =>
    run(() => overrideRegistrationStatus(eventId, row.userId, status, reason), { success, error: `Couldn't update ${row.displayName}` }, row.id)

  /** Promote or restore someone. Asks first when it skips payment or goes past the capacity. */
  const register = async (row: RegistrationRow, reason: "Admin promote" | "Admin restore") => {
    const warnings = [
      isPaid && !row.paid ? "This is a paid event and they haven't paid; they'll be registered without paying." : null,
      full ? `The event is full (${registered.length} / ${registrationMax}), so this goes past the capacity.` : null,
    ].filter(Boolean)
    if (warnings.length > 0) {
      const ok = await confirm({ title: `Register ${row.displayName}?`, description: warnings.join(" "), confirmLabel: "Register them" })
      if (!ok) return
    }
    await setStatus(row, "REGISTERED", reason, `${row.displayName} is registered`)
  }

  const remove = (row: RegistrationRow) =>
    run(() => removeRegistration(eventId, row.userId), { success: `Removed ${row.displayName}`, error: `Couldn't remove ${row.displayName}` }, row.id)

  const removeItem = (row: RegistrationRow) => ({
    label: "Remove registration",
    disabled: busyKey === row.id,
    destructive: {
      title: `Remove ${row.displayName}?`,
      description: [
        "Their registration is deleted, and they aren't notified.",
        row.status === "REGISTERED" ? "Their spot opens up for the waitlist." : null,
        row.paid ? "This doesn't refund their payment; refund it in Stripe if needed." : null,
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Remove",
    },
    onSelect: () => remove(row),
  })

  const registeredColumns: Column<RegistrationRow>[] = [
    {
      id: "member",
      header: "Member",
      sortValue: (row) => row.displayName,
      className: "max-w-[10rem] sm:max-w-[16rem]",
      cell: (row) => <CellStack primary={row.displayName} secondary={`@${row.handle}`} />,
    },
    { id: "source", header: "How", hideBelow: "md", cell: (row) => <Source row={row} /> },
    {
      id: "date",
      header: "Signed up",
      hideBelow: "sm",
      sortValue: (row) => row.createdAt,
      className: "whitespace-nowrap",
      cell: (row) => centralDateTime(row.createdAt),
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Section title="Registered" count={registrationMax != null ? `${registered.length} / ${registrationMax}` : registered.length} hint={full ? "Full" : undefined}>
        <DataTable
          rows={registered}
          columns={registeredColumns}
          getRowId={(row) => row.id}
          minWidth={340}
          noun={{ one: "person", many: "people" }}
          search={registered.length > 8 ? { placeholder: "Search registered", text: (row) => `${row.displayName} ${row.handle}` } : undefined}
          empty={<EmptyState title="Nobody has registered yet" description="People who sign up on the event page show up here." />}
          rowActions={(row) => (
            <RowActions>
              <RowMenu
                label={`Actions for ${row.displayName}`}
                items={[
                  {
                    label: "Move to the waitlist",
                    disabled: busyKey === row.id,
                    destructive: {
                      title: `Move ${row.displayName} to the waitlist?`,
                      description: "They lose their spot and go to the end of the waitlist. If spots fill automatically, the next person moves up.",
                      confirmLabel: "Move to waitlist",
                    },
                    onSelect: () => setStatus(row, "WAITLISTED", "Admin demote", `${row.displayName} moved to the waitlist`),
                  },
                  "separator",
                  removeItem(row),
                ]}
              />
            </RowActions>
          )}
        />
      </Section>

      <Section title="Waitlist" count={waitlistRows.length} hint={waitlistRows.length > 1 ? "Drag to reorder; the top person moves up first" : undefined}>
        {waitlistRows.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState title="Nobody is waiting" description="When the event is full and the waitlist is on, new sign-ups queue here." />
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <Table minWidth={340}>
                <THead>
                  <TH>
                    <span className="sr-only">Reorder</span>
                  </TH>
                  <TH className="text-right">#</TH>
                  <TH>Member</TH>
                  <TH className="hidden sm:table-cell">Joined</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </THead>
                <tbody>
                  {waitlistRows.map((row, index) => (
                    <SortableRow key={row.id} id={row.id} position={index + 1}>
                      <TD className="max-w-[10rem] sm:max-w-[16rem]">
                        <CellStack primary={row.displayName} secondary={`@${row.handle}`} />
                      </TD>
                      <TD className="hidden whitespace-nowrap sm:table-cell">{centralDateTime(row.createdAt)}</TD>
                      <TD className="w-px px-2 py-1">
                        <RowActions>
                          <Button size="sm" pending={busyKey === row.id} disabled={busyKey === "reorder"} onClick={() => register(row, "Admin promote")}>
                            Promote
                          </Button>
                          <RowMenu label={`Actions for ${row.displayName}`} items={[removeItem(row)]} />
                        </RowActions>
                      </TD>
                    </SortableRow>
                  ))}
                </tbody>
              </Table>
            </SortableContext>
          </DndContext>
        )}
      </Section>

      {notAttending.length > 0 && (
        <Section title="Not attending" count={notAttending.length} hint="Cancelled or taken off the list">
          <DataTable
            rows={notAttending}
            columns={[
              registeredColumns[0],
              {
                id: "updated",
                header: "Since",
                hideBelow: "sm",
                sortValue: (row) => row.updatedAt,
                className: "whitespace-nowrap",
                cell: (row) => centralDateTime(row.updatedAt),
              },
            ]}
            getRowId={(row) => row.id}
            minWidth={340}
            noun={{ one: "person", many: "people" }}
            rowActions={(row) => (
              <RowActions>
                <Button size="sm" pending={busyKey === row.id} onClick={() => register(row, "Admin restore")}>
                  Register again
                </Button>
              </RowActions>
            )}
          />
        </Section>
      )}
    </div>
  )
}
