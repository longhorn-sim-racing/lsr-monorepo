import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ExternalLink, Pencil } from "lucide-react"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { getEventAttendanceState } from "@/server/services/attendance.service"
import { generateQrCodeDataUrl } from "@/lib/qr"
import { getSiteUrl } from "@/lib/site-url"
import { getEffectiveEventStatus, isEventPublic } from "@/lib/events"
import { Button, PageHeader, SplitLayout, Stat, StatRow, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/admin/kit"
import { AttendanceManager, type GuestRow } from "@/components/admin/attendance-manager"
import { AttendanceConfigForm } from "@/components/admin/attendance-config-form"
import { RegistrationManager, type RegistrationRow } from "@/components/admin/registration-manager"
import { RegistrationConfigForm } from "@/components/admin/registration-config-form"
import { LiveTailButton } from "@/components/admin/live-tail-button"
import { EventStatusBadge } from "@/app/admin/events/_components/event-status"
import { centralDay, centralTimeRange } from "@/app/admin/events/_components/format"

export const metadata: Metadata = { title: "Manage event" }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default async function ManageEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params

  const [attendanceState, registrations] = await Promise.all([
    getEventAttendanceState(id).catch(() => null),
    // Every registration (waitlisted and cancelled ones too), oldest first
    prisma.eventRegistration.findMany({
      where: { eventId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        status: true,
        waitlistOrder: true,
        promotionSource: true,
        sourcePaymentId: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { displayName: true, handle: true } },
      },
    }),
  ])

  if (!attendanceState) notFound()
  const { event, lists } = attendanceState

  // The QR needs an absolute URL
  const checkInUrl = `${getSiteUrl()}/check-in/${event.id}`
  const qrDataUrl = await generateQrCodeDataUrl(checkInUrl)

  const walkInIds = new Set(lists.walkIns.map((attendance) => attendance.id))
  const guests: GuestRow[] = [
    ...lists.checkedIn.map((attendance) => ({
      key: attendance.id,
      userId: attendance.userId,
      displayName: attendance.user.displayName,
      handle: attendance.user.handle,
      state: walkInIds.has(attendance.id) ? ("walk-in" as const) : ("checked-in" as const),
      method: attendance.method,
      checkedInAt: attendance.checkedInAt,
    })),
    ...lists.missing.map((registration) => ({
      key: registration.id,
      userId: registration.userId,
      displayName: registration.user.displayName,
      handle: registration.user.handle,
      state: "missing" as const,
      method: null,
      checkedInAt: null,
    })),
  ]

  const registrationRows: RegistrationRow[] = registrations.map((registration) => ({
    id: registration.id,
    userId: registration.userId,
    displayName: registration.user.displayName,
    handle: registration.user.handle,
    status: registration.status,
    waitlistOrder: registration.waitlistOrder,
    promotionSource: registration.promotionSource,
    paid: registration.sourcePaymentId != null,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  }))

  const registered = registrationRows.filter((r) => r.status === "REGISTERED").length
  const waitlisted = registrationRows.filter((r) => r.status === "WAITLISTED").length
  const max = event.registrationMax
  const isPaid = (event.registrationFeeCents ?? 0) > 0
  const started = new Date() >= event.startsAtUtc

  return (
    <>
      <PageHeader
        title={event.title}
        back={{ href: "/admin/events", label: "Events" }}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <EventStatusBadge status={getEffectiveEventStatus(event)} />
            <span>
              {centralDay(event.startsAtUtc)} · {centralTimeRange(event.startsAtUtc, event.endsAtUtc)}
            </span>
          </span>
        }
        actions={
          <>
            <LiveTailButton />
            <Button asChild>
              <a href={`/events/${event.slug}`} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                {isEventPublic(event) ? "View page" : "Preview page"}
              </a>
            </Button>
            <Button asChild>
              <Link href={`/admin/events/${event.id}/edit`}>
                <Pencil aria-hidden />
                Edit details
              </Link>
            </Button>
          </>
        }
      />

      <StatRow>
        <Stat
          label="Registered"
          value={max != null ? `${registered} / ${max}` : registered}
          hint={!event.registrationEnabled ? "Registration is off" : max == null ? "No limit" : registered >= max ? "Full" : `${plural(max - registered, "spot", "spots")} left`}
        />
        <Stat
          label="Waitlist"
          value={waitlisted}
          hint={!event.registrationWaitlistEnabled ? "Waitlist is off" : isPaid || !event.waitlistAutoPromote ? "Promoted by hand" : "Moves up automatically"}
        />
        <Stat label="Checked in" value={lists.checkedIn.length} hint={event.attendanceEnabled ? "Check-in is on" : "Check-in is off"} />
        <Stat
          label="Not checked in"
          value={lists.missing.length}
          hint={event.attendanceEnabled ? "Registered, not here yet" : "Counted as attended while check-in is off"}
        />
        <Stat label="Walk-ins" value={lists.walkIns.length} hint="Checked in without registering" />
      </StatRow>

      <Tabs defaultValue={event.attendanceEnabled || started ? "attendance" : "registration"}>
        <TabsList>
          <TabsTrigger value="attendance">
            Attendance <span className="text-xs font-normal tabular-nums text-admin-subtle">{lists.checkedIn.length}</span>
          </TabsTrigger>
          <TabsTrigger value="registration">
            Registration <span className="text-xs font-normal tabular-nums text-admin-subtle">{registered}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attendance">
          <SplitLayout
            main={<AttendanceManager eventId={event.id} eventTitle={event.title} checkInUrl={checkInUrl} qrDataUrl={qrDataUrl} guests={guests} />}
            side={<AttendanceConfigForm event={event} checkInCount={lists.checkedIn.length} />}
          />
        </TabsContent>

        <TabsContent value="registration">
          <SplitLayout
            main={<RegistrationManager eventId={event.id} registrations={registrationRows} registrationMax={max} isPaid={isPaid} />}
            side={<RegistrationConfigForm event={event} />}
          />
        </TabsContent>
      </Tabs>
    </>
  )
}
