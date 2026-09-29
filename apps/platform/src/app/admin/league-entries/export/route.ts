import { NextRequest, NextResponse } from "next/server";
import { requireOfficer } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { getEntrantRows } from "@/server/queries/league-entrants";
import { equipmentLabel, experienceLabel } from "@/schemas/league-application.schema";

const csvCell = (value: unknown) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET /admin/league-entries/export?season=<slug> → CSV of the season's entrants. */
export async function GET(req: NextRequest) {
  try {
    await requireOfficer();
  } catch {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  const slug = req.nextUrl.searchParams.get("season");
  const season = slug ? await prisma.season.findUnique({ where: { slug }, select: { id: true, slug: true } }) : null;
  if (!season) return NextResponse.json({ message: "Unknown season" }, { status: 404 });

  const rows = (await getEntrantRows(season.id)) ?? [];
  const header = [
    "Name", "Handle", "Email", "UT EID", "School", "Discord", "Car number", "Experience", "Equipment",
    "Can commit", "Entry status", "Paid", "Entered at", "Returning rate", "Form submitted", "Form source", "Notes",
  ];
  const lines = rows.map((r) =>
    [
      r.displayName,
      r.handle,
      r.email,
      r.eid,
      r.application ? r.application.school ?? "UT Austin" : "",
      r.application?.discordUsername,
      r.racing.racingNumber,
      r.application ? experienceLabel(r.application.experience) : "",
      r.application?.equipment.map(equipmentLabel).join("; "),
      r.application ? (r.application.canCommit ? "yes" : "no") : "",
      r.status,
      r.paidCents !== null ? (r.paidCents / 100).toFixed(2) : "",
      r.paidAt,
      r.returningRate ? "yes" : "",
      r.application?.createdAt,
      r.application?.source,
      r.application?.notes,
    ].map(csvCell).join(",")
  );

  return new NextResponse([header.join(","), ...lines].join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${season.slug}-entrants.csv"`,
    },
  });
}
