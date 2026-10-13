"use client"

import { useMemo, useState } from "react"
import Image from "next/image"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Copy, Download, Maximize2, QrCode, X } from "lucide-react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  CellStack,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Panel,
  PanelBody,
  PanelHeader,
  RowActions,
  RowMenu,
  Segmented,
  UserPicker,
  type AdminUserOption,
  type Column,
} from "@/components/admin/kit"
import { manualCheckIn, manualRemoveCheckIn } from "@/app/admin/events/actions"
import { useAction } from "@/app/admin/events/_components/use-action"
import { centralTime } from "@/app/admin/events/_components/format"

/** Someone on the guest list: checked in (registered or not), or registered but not here yet. */
export type GuestRow = {
  key: string
  userId: string
  displayName: string
  handle: string
  state: "checked-in" | "walk-in" | "missing"
  method: "QR" | "MANUAL" | null
  checkedInAt: Date | null
}

type View = "all" | "checked-in" | "missing" | "walk-in"

const IN_VIEW: Record<View, (row: GuestRow) => boolean> = {
  all: () => true,
  "checked-in": (row) => row.state !== "missing",
  missing: (row) => row.state === "missing",
  "walk-in": (row) => row.state === "walk-in",
}

const EMPTY: Record<View, string> = {
  all: "Nobody has registered or checked in yet.",
  "checked-in": "Nobody has checked in yet.",
  missing: "Everyone who registered has checked in.",
  "walk-in": "Nobody has checked in without registering.",
}

function StateBadge({ row }: { row: GuestRow }) {
  if (row.state === "missing") return <Badge tone="warning">Not checked in</Badge>
  if (row.state === "walk-in") return <Badge tone="info">Walk-in</Badge>
  return <Badge tone="success">Checked in</Badge>
}

/** The check-in QR shown big for a projector or a phone held up at the door: covers the whole screen. */
function ProjectorView({ open, onClose, eventTitle, qrDataUrl, checkInUrl }: { open: boolean; onClose: () => void; eventTitle: string; qrDataUrl: string; checkInUrl: string }) {
  const close = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {})
    onClose()
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-[4vh] overflow-y-auto bg-card p-6 text-center outline-none">
          <DialogPrimitive.Title className="max-w-5xl text-3xl font-bold leading-tight sm:text-5xl lg:text-6xl">{eventTitle}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Scan the QR code to check in</DialogPrimitive.Description>
          <div className="rounded-lg border bg-card p-3 shadow-sm">
            <Image src={qrDataUrl} alt="Check-in QR code" width={600} height={600} unoptimized className="size-[min(60vh,80vw)] object-contain" />
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-xl font-semibold sm:text-2xl">Scan to check in</p>
            <p className="break-all text-sm text-admin-subtle">{checkInUrl}</p>
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton label="Close full screen" variant="secondary" className="absolute right-4 top-4">
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function AttendanceManager({
  eventId,
  eventTitle,
  checkInUrl,
  qrDataUrl,
  guests,
}: {
  eventId: string
  eventTitle: string
  checkInUrl: string
  qrDataUrl: string
  guests: GuestRow[]
}) {
  const [view, setView] = useState<View>("all")
  const [qrOpen, setQrOpen] = useState(false)
  const [projecting, setProjecting] = useState(false)
  const [member, setMember] = useState<AdminUserOption | null>(null)
  const { run, busyKey } = useAction()

  const checkedInIds = useMemo(() => new Set(guests.filter((g) => g.state !== "missing").map((g) => g.userId)), [guests])
  const memberAlreadyIn = member != null && checkedInIds.has(member.id)

  const rows = useMemo(
    () =>
      guests.filter(IN_VIEW[view]).sort((a, b) => {
        // Newest check-ins first, then the people still expected, by name
        if (a.checkedInAt && b.checkedInAt) return b.checkedInAt.getTime() - a.checkedInAt.getTime()
        if (a.checkedInAt || b.checkedInAt) return a.checkedInAt ? -1 : 1
        return a.displayName.localeCompare(b.displayName)
      }),
    [guests, view],
  )

  const checkIn = (userId: string, name: string, key: string) =>
    run(() => manualCheckIn(eventId, userId), { success: `${name} checked in`, error: `Couldn't check in ${name}` }, key)

  const undo = (row: GuestRow) =>
    run(() => manualRemoveCheckIn(eventId, row.userId), { success: `Removed ${row.displayName}'s check-in`, error: "Couldn't remove the check-in" }, row.key)

  const checkInPicked = async () => {
    if (!member) return
    const ok = await checkIn(member.id, member.displayName, "picker")
    if (ok) setMember(null)
  }

  const downloadQr = () => {
    const link = document.createElement("a")
    link.href = qrDataUrl
    link.download = `event-${eventId}-qr.png`
    link.click()
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(checkInUrl)
      toast.success("Check-in link copied")
    } catch {
      toast.error("Couldn't copy the link. Select it and copy it by hand.")
    }
  }

  const project = () => {
    setQrOpen(false)
    setProjecting(true)
    // Ask the browser for real full screen too; phones that can't just get the overlay
    document.documentElement.requestFullscreen?.()?.catch(() => {})
  }

  const columns: Column<GuestRow>[] = [
    {
      id: "member",
      header: "Member",
      sortValue: (row) => row.displayName,
      className: "max-w-[16rem]",
      cell: (row) => <CellStack primary={row.displayName} secondary={`@${row.handle}`} />,
    },
    { id: "state", header: "Status", sortValue: (row) => row.state, cell: (row) => <StateBadge row={row} /> },
    {
      id: "time",
      header: "Checked in",
      hideBelow: "sm",
      sortValue: (row) => row.checkedInAt,
      className: "whitespace-nowrap",
      cell: (row) =>
        row.checkedInAt ? (
          <span>
            {centralTime(row.checkedInAt)} <span className="text-admin-subtle">· {row.method === "QR" ? "QR" : "By an officer"}</span>
          </span>
        ) : (
          <span className="text-admin-subtle">Not yet</span>
        ),
    },
  ]

  const count = (v: View) => guests.filter(IN_VIEW[v]).length

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Check people in"
          description="Members scan the QR code with their phone, or check them in here."
          actions={
            <Button onClick={() => setQrOpen(true)}>
              <QrCode aria-hidden />
              Show QR code
            </Button>
          }
        />
        <PanelBody>
          <Field
            label="Member"
            htmlFor="check-in-member"
            hint={memberAlreadyIn ? `${member?.displayName} is already checked in.` : "Search by name, handle, email or EID. People who didn't register count as walk-ins."}
          >
            <div className="flex flex-wrap items-center gap-2">
              <UserPicker id="check-in-member" value={member} onChange={setMember} placeholder="Find a member" className="min-w-0 flex-[1_1_240px]" />
              <Button variant="primary" onClick={checkInPicked} disabled={!member || memberAlreadyIn} pending={busyKey === "picker"}>
                Check in
              </Button>
            </div>
          </Field>
        </PanelBody>
      </Panel>

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.key}
        minWidth={480}
        noun={{ one: "person", many: "people" }}
        search={{ placeholder: "Search the guest list", text: (row) => `${row.displayName} ${row.handle}` }}
        filters={
          <Segmented
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: "Everyone", count: count("all") },
              { value: "checked-in", label: "Checked in", count: count("checked-in") },
              { value: "missing", label: "Not checked in", count: count("missing") },
              { value: "walk-in", label: "Walk-ins", count: count("walk-in") },
            ]}
          />
        }
        empty={<EmptyState title="No one here" description={EMPTY[view]} />}
        rowActions={(row) =>
          row.state === "missing" ? (
            <RowActions>
              <Button size="sm" pending={busyKey === row.key} onClick={() => checkIn(row.userId, row.displayName, row.key)}>
                Check in
              </Button>
            </RowActions>
          ) : (
            <RowActions>
              <RowMenu
                label={`More actions for ${row.displayName}`}
                items={[
                  {
                    label: "Remove check-in",
                    disabled: busyKey === row.key,
                    destructive: {
                      title: `Remove ${row.displayName}'s check-in?`,
                      description: row.state === "walk-in" ? "They didn't register, so they drop off the guest list." : "They go back to not checked in.",
                      confirmLabel: "Remove check-in",
                    },
                    onSelect: () => undo(row),
                  },
                ]}
              />
            </RowActions>
          )
        }
      />

      <Dialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        title="Check-in QR code"
        description="Members scan it to check themselves in while check-in is open."
        footer={
          <>
            <Button onClick={copyLink}>
              <Copy aria-hidden />
              Copy link
            </Button>
            <Button onClick={downloadQr}>
              <Download aria-hidden />
              Download
            </Button>
            <Button variant="primary" onClick={project}>
              <Maximize2 aria-hidden />
              Full screen
            </Button>
          </>
        }
      >
        <div className="flex flex-col items-center gap-3">
          <Image src={qrDataUrl} alt="Check-in QR code" width={256} height={256} unoptimized className="size-64 rounded-md border" />
          <p className="break-all text-center text-xs text-admin-subtle">{checkInUrl}</p>
        </div>
      </Dialog>

      <ProjectorView open={projecting} onClose={() => setProjecting(false)} eventTitle={eventTitle} qrDataUrl={qrDataUrl} checkInUrl={checkInUrl} />
    </div>
  )
}
