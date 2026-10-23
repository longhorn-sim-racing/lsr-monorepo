import type { Metadata } from "next"
import { PageHeader } from "@/components/admin/kit"
import { requireOfficerPage } from "@/server/auth/guards"
import { listKnowledgeOwners } from "@/server/jack/knowledge/queries"
import { KnowledgeForm } from "../_components/knowledge-form"

export const metadata: Metadata = { title: "New knowledge entry" }

export default async function NewKnowledgeEntryPage() {
  const user = await requireOfficerPage()
  const owners = await listKnowledgeOwners()

  return (
    <>
      <PageHeader back={{ href: "/admin/knowledge", label: "Knowledge" }} title="New entry" description="Something the club should remember. Jack finds it, cites it and says how old it is." />
      <div className="max-w-4xl">
        <KnowledgeForm
          id={null}
          baseVersionId={null}
          reviewed={false}
          owners={owners}
          initial={{ title: "", body: "", tags: "", sourceNote: "", sourceUrl: "", sourceDate: "", ownerId: owners.some((o) => o.id === user.id) ? user.id : "" }}
        />
      </div>
    </>
  )
}
