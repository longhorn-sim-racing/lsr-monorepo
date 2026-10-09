import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { CheckInView } from "@/components/events/check-in-view";
import { DatabaseUnavailable } from "@/components/database-unavailable";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { DEFAULT_TIMEZONE } from "@/lib/dates";

/** Phones scan into this page at the door: a photo backdrop with the card centred over it */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-[calc(100svh-5rem)] items-center justify-center overflow-hidden bg-lsr-charcoal px-4 py-12">
      <div className="absolute inset-0 z-0">
        <CloudinaryImage publicId="gallery/wec-at-cota-2025/dsc09855" alt="" fill preload sizes="100vw" className="object-cover object-[center_30%] opacity-40" />
        <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/60 to-lsr-charcoal" />
      </div>
      <div className="relative z-10 flex w-full justify-center">{children}</div>
    </div>
  );
}

export default async function CheckInPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params;

  let user;
  try {
    ({ user } = await getSessionUser());
  } catch (error) {
    console.error('[CheckIn] Failed to load session:', error);
    return (
      <Shell>
        <DatabaseUnavailable title="Check-in Unavailable" message="We're experiencing issues. Please try again in a few minutes." />
      </Shell>
    );
  }

  if (!user) {
    redirect(`/auth/signin?next=/check-in/${eventId}`);
  }

  let event;
  try {
    event = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        slug: true,
        timezone: true,
        attendanceEnabled: true,
        attendanceOpensAt: true,
        attendanceClosesAt: true,
      },
    });
  } catch (error) {
    console.error('[CheckIn] Failed to load event:', error);
    return (
      <Shell>
        <DatabaseUnavailable title="Check-in Unavailable" message="We're experiencing issues. Please try again in a few minutes." />
      </Shell>
    );
  }

  if (!event) {
    return (
      <Shell>
        <div className="relative w-full max-w-md border border-white/10 bg-lsr-charcoal/85 p-8 text-white backdrop-blur-md">
          <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
          <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Check-in</p>
          <h1 className="mt-2 font-display font-black italic text-4xl uppercase leading-[0.95]">Event not found</h1>
          <p className="mt-4 font-sans text-sm leading-relaxed text-white/70">This check-in code doesn&apos;t match an event. Ask an officer for the right one.</p>
          <Link href="/events" className="mt-6 inline-block font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-lsr-orange hover:text-white">
            See the schedule
          </Link>
        </div>
      </Shell>
    );
  }

  let existing;
  try {
    existing = await prisma.eventAttendance.findUnique({
      where: { eventId_userId: { eventId, userId: user.id } },
    });
  } catch {
    existing = null;
  }

  const now = new Date();
  let status: "OPEN" | "NOT_ENABLED" | "NOT_OPEN_YET" | "CLOSED" | "ALREADY_CHECKED_IN" = "OPEN";
  let opensAt: Date | null = null;

  if (existing) {
    status = "ALREADY_CHECKED_IN";
  } else if (!event.attendanceEnabled) {
    status = "NOT_ENABLED";
  } else if (event.attendanceOpensAt && now < event.attendanceOpensAt) {
    status = "NOT_OPEN_YET";
    opensAt = event.attendanceOpensAt;
  } else if (event.attendanceClosesAt && now > event.attendanceClosesAt) {
    status = "CLOSED";
  }

  // Formatted here, in the event's own time zone, so the server and the phone show the same thing
  const timeZone = event.timezone || DEFAULT_TIMEZONE;
  const time = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });

  return (
    <Shell>
      <CheckInView
        eventId={event.id}
        eventSlug={event.slug}
        eventTitle={event.title}
        timeZone={timeZone}
        status={status}
        opensAt={opensAt ? { time: time(opensAt), date: opensAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone }) } : undefined}
        checkedInAt={existing ? time(existing.checkedInAt) : undefined}
        currentUser={{
          displayName: user.displayName,
          handle: user.handle,
          avatarUrl: user.avatarUrl,
        }}
      />
    </Shell>
  );
}
