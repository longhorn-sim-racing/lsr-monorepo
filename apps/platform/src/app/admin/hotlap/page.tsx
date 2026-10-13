import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { Button, PageHeader } from "@/components/admin/kit"
import { getHotlapSettings } from "./actions"
import HotlapForm from "./hotlap-form"

export const metadata: Metadata = { title: "Hotlap" }

export default async function AdminHotlapPage() {
  await requireOfficerPage()
  const settings = await getHotlapSettings()

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Hotlap of the week"
        description="The featured lap video on the home page."
        actions={
          <Button asChild>
            <a href="/" target="_blank" rel="noreferrer">
              View home page
            </a>
          </Button>
        }
      />
      <HotlapForm initial={settings} />
    </div>
  )
}
