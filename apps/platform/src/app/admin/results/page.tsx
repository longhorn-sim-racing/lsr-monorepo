import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { SafeSlot } from "@/components/admin/safe-slot"
import { PerformancePanel } from "./_components/performance-panel"
import { ResultsAdminClient } from "./client"

export const metadata: Metadata = { title: "Results" }

export default async function ResultsAdminPage({ searchParams }: { searchParams: Promise<{ upload?: string }> }) {
  await requireOfficerPage()
  const { upload } = await searchParams
  // Everything but the raw JSON, which can be large; downloads fetch it from ./[id]/raw
  const results = await prisma.rawResultUpload.findMany({
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      filename: true,
      filesize: true,
      status: true,
      uploadedAt: true,
      sessionLabel: true,
      pointsSystem: true,
      uploadedBy: { select: { displayName: true } },
      event: { select: { id: true, title: true } },
    },
  })

  // ?upload=1 (from the Overview) opens the upload dialog
  return (
    <>
      <ResultsAdminClient results={results} openUpload={upload === "1"} />
      <SafeSlot id="best laps and form" where="results" render={() => PerformancePanel()} />
    </>
  )
}
