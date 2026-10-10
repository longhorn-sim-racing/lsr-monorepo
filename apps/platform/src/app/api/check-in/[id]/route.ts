import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { checkInUser } from "@/server/services/attendance.service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user } = await getSessionUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { id: eventId } = await params;

    // Use the service to check in
    const result = await checkInUser(
      eventId,
      user.id,
      "QR", // This route is specifically for self/QR check-in
      user.id // Actor is the user themselves
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Check-in error:", error);
    return NextResponse.json(
      { message: error instanceof Error && error.message ? error.message : "Failed to check in" },
      { status: 400 }
    );
  }
}
