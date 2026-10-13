import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { PostForm } from "../_components/post-form"

export const metadata: Metadata = { title: "New post" }

export default async function NewPostPage() {
  const officer = await requireOfficerPage()

  const tags = await prisma.tag.findMany({
    select: { name: true },
    orderBy: { name: "asc" },
  })

  return (
    <>
      <PageHeader title="New post" description="Leave the publish date blank to save it as a draft." back={{ href: "/admin/news", label: "News" }} />
      <PostForm
        // The officer writing it, unless they pick someone else
        author={{
          id: officer.id,
          displayName: officer.displayName,
          handle: officer.handle,
          email: officer.email,
          avatarUrl: officer.avatarUrl,
          eid: officer.eid,
        }}
        availableTags={tags.map((t) => t.name)}
      />
    </>
  )
}
