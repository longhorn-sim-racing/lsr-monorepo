import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { createEventCheckoutSession } from "@/server/services/payment.service";
import { prisma } from "@/server/db";
import { isEventPublic } from "@/lib/events";
import { isViewerOfficer } from "@/server/auth/guards";

type Params = {
  params: Promise<{ slug: string }>;
};

export async function POST(req: NextRequest, { params }: Params) {
  const { slug } = await params;
  const { user } = await getSessionUser();

  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const event = await prisma.event.findUnique({
    where: { slug },
    select: { status: true, publishedAt: true, visibility: true },
  });
  if (!event || (!isEventPublic(event) && !(await isViewerOfficer()))) {
    return NextResponse.json({ message: "Event not found" }, { status: 404 });
  }

  try {
    const url = await createEventCheckoutSession(user.id, slug);
    return NextResponse.json({ url });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "Failed to create checkout session",
      },
      { status: 400 }
    );
  }
}
