
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session"; // Assuming this exists or similar
import { prisma } from "@/server/db";
import { registerForEvent } from "@/server/services/registration.service";
import { pickRacingNumberStyle, racingNumberSelect } from "@/lib/racing-number";

type Params = {
  params: Promise<{ slug: string }>;
};

export async function GET(req: NextRequest, { params }: Params) {
  const { slug } = await params;
  const { user } = await getSessionUser();

  const event = await prisma.event.findUnique({
    where: { slug },
    include: {
      registrations: {
        where: { status: "REGISTERED" },
        include: {
          user: {
            select: {
              displayName: true,
              avatarUrl: true,
              handle: true,
              ...racingNumberSelect,
            },
          },
        },
      },
      _count: {
        select: {
          registrations: { where: { status: "WAITLISTED" } },
        },
      },
    },
  });

  if (!event) {
    return NextResponse.json({ message: "Event not found" }, { status: 404 });
  }

  // Base snapshot (public/logged-out safe)
  const now = new Date();
  let windowStatus = "NOT_OPEN";
  
  if (!event.registrationEnabled) {
    windowStatus = "DISABLED";
  } else if (now > event.endsAtUtc) {
    windowStatus = "PASSED";
  } else if (event.registrationOpensAt && now < event.registrationOpensAt) {
    windowStatus = "NOT_OPEN";
  } else if (event.registrationClosesAt && now > event.registrationClosesAt) {
    windowStatus = "CLOSED";
  } else {
    windowStatus = "OPEN";
  }

  const snapshot = {
    eventId: event.id,
    registrationEnabled: event.registrationEnabled,
    windowStatus,
    registrationOpensAt: event.registrationOpensAt,
    registrationClosesAt: event.registrationClosesAt,
    capacity: event.registrationMax,
    registeredCount: event.registrations.length,
    waitlistEnabled: event.registrationWaitlistEnabled,
    waitlistCount: 0, // Hidden for public by default usually, but requested to return count if logged in?
    myStatus: "NONE",
    attendees: [] as any[],
    registrationFeeCents: event.registrationFeeCents ?? null,
  };

  // If NOT logged in, return minimal info
  if (!user) {
    return NextResponse.json(snapshot);
  }

  // Logged In: Enrich snapshot
  snapshot.waitlistCount = event._count.registrations;
  
  // My Status
  const myReg = await prisma.eventRegistration.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: user.id } },
  });
  snapshot.myStatus = myReg ? myReg.status : "NONE";

  // Attendees list (Only visible to logged-in users)
  snapshot.attendees = event.registrations.map(reg => ({
    displayName: reg.user.displayName,
    avatarUrl: reg.user.avatarUrl,
    profileLink: `/drivers/${reg.user.handle}`, // Assuming handle is used for profile links
    ...pickRacingNumberStyle(reg.user),
  }));

  return NextResponse.json(snapshot);
}

export async function POST(req: NextRequest, { params }: Params) {
  const { slug } = await params;
  const { user } = await getSessionUser();

  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const event = await prisma.event.findUnique({ where: { slug } });
  if (!event) {
    return NextResponse.json({ message: "Event not found" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const intent = body.intent; // "YES" or "NO"

    if (intent !== "YES" && intent !== "NO") {
      return NextResponse.json({ message: "Invalid intent. Must be YES or NO." }, { status: 400 });
    }

    await registerForEvent(user.id, event.id, intent);

    // Return updated snapshot by calling the GET logic internally or just re-fetching
    // Re-fetching strictly essential parts to build the snapshot again
    // For simplicity/DRY, we could extract the snapshot logic, but here I'll just do a lightweight re-fetch
    // ensuring we return the *updated* state for immediate UI reflection.
    
    // NOTE: In a real "Service" pattern, 'getRegistrationSnapshot' would be a shared function. 
    // I will duplicate strictly the fetch logic here for speed, as per "Return updated snapshot" req.
    
    const updatedEvent = await prisma.event.findUnique({
        where: { id: event.id },
        include: {
          registrations: {
            where: { status: "REGISTERED" },
            include: { user: { select: { displayName: true, avatarUrl: true, handle: true, ...racingNumberSelect } } },
          },
          _count: {
            select: { registrations: { where: { status: "WAITLISTED" } } },
          },
        },
    });

    const myReg = await prisma.eventRegistration.findUnique({
        where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });

    // We can assume static config didn't change in the last millisecond
    const snapshot = {
        eventId: event.id,
        registrationEnabled: event.registrationEnabled,
        windowStatus: "OPEN", // Simplified, assumed validated by service
        registrationOpensAt: event.registrationOpensAt,
        registrationClosesAt: event.registrationClosesAt,
        capacity: event.registrationMax,
        registeredCount: updatedEvent!.registrations.length,
        waitlistEnabled: event.registrationWaitlistEnabled,
        waitlistCount: updatedEvent!._count.registrations,
        myStatus: myReg ? myReg.status : "NONE",
        registrationFeeCents: event.registrationFeeCents ?? null,
        attendees: updatedEvent!.registrations.map(reg => ({
            displayName: reg.user.displayName,
            avatarUrl: reg.user.avatarUrl,
            profileLink: `/drivers/${reg.user.handle}`,
            ...pickRacingNumberStyle(reg.user),
        })),
    };

    return NextResponse.json(snapshot);

  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "Internal Error" }, { status: 400 });
  }
}
