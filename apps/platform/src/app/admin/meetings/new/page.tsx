import type { Metadata } from "next"
import { PageHeader } from "@/components/admin/kit"
import { requireOfficerPage } from "@/server/auth/guards"
import { centralDate } from "@/server/jack/tools/time"
import { MeetingForm } from "../_components/meeting-form"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "New meeting" }

export default async function NewMeetingPage() {
  await requireOfficerPage()
  return (
    <>
      <PageHeader
        back={{ href: "/admin/meetings", label: "Meetings" }}
        title="New meeting"
        description="Record a meeting before it happens (with its agenda) or after (with a summary). Add decisions and action items on its page once it's saved."
      />
      <div className="max-w-3xl">
        <MeetingForm id={null} initial={{ title: "", type: "board", date: centralDate(new Date()), time: "", agendaMd: "", summaryMd: "" }} />
      </div>
    </>
  )
}
