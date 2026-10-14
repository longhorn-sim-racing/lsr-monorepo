import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { Button, PageHeader } from "@/components/admin/kit"
import { getFeaturedVideoForAdmin } from "./actions"
import { FeaturedSwitch } from "./featured-switch"
import HotlapForm from "./hotlap-form"
import ClipForm from "./clip-form"

export const metadata: Metadata = { title: "Hotlap and clips" }

export default async function AdminHotlapPage() {
  await requireOfficerPage()
  const settings = await getFeaturedVideoForAdmin()

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Hotlap and clips"
        description="The video on the home page: the hotlap of the week or a competition clip."
        actions={
          <Button asChild>
            <a href="/#hotlap" target="_blank" rel="noreferrer">
              View home page
            </a>
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <FeaturedSwitch show={settings.show} hasClip={!!settings.clip} />
        <HotlapForm initial={settings.hotlap} showing={settings.show === "hotlap"} />
        <ClipForm initial={settings.clip} showing={settings.show === "clip"} />
      </div>
    </div>
  )
}
