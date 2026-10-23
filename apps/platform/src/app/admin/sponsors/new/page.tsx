import type { Metadata } from "next"
import { PageHeader } from "@/components/admin/kit"
import { requireOfficerPage } from "@/server/auth/guards"
import { listOfficers } from "@/server/services/officers"
import type { ProspectFormInput } from "../actions"
import { ProspectForm } from "../_components/prospect-form"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "New prospect" }

const EMPTY: ProspectFormInput = {
  company: "",
  website: "",
  contactName: "",
  contactEmail: "",
  contactRole: "",
  stage: "idea",
  tierInterest: "",
  ownerId: "",
  nextStep: "",
  nextStepDue: "",
  notes: "",
}

export default async function NewProspectPage() {
  await requireOfficerPage()
  const owners = await listOfficers()
  return (
    <>
      <PageHeader back={{ href: "/admin/sponsors", label: "Sponsors" }} title="New prospect" description="A company the club could approach, or is already talking to, about sponsorship." />
      <div className="max-w-3xl">
        <ProspectForm id={null} initial={EMPTY} owners={owners} />
      </div>
    </>
  )
}
