import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { getAllPostsForAdmin } from "@/server/queries/news"
import { NewsConsole, type NewsRow } from "@/components/admin/news-console"
import { requireOfficerPage } from "@/server/auth/guards"
import { Button, PageHeader } from "@/components/admin/kit"

export const metadata: Metadata = { title: "News" }

export default async function AdminNewsPage() {
  await requireOfficerPage()
  const posts = await getAllPostsForAdmin()
  const now = new Date()

  // Only what the list shows, so author emails and post bodies stay out of the page
  const rows: NewsRow[] = posts.map((post) => ({
    id: post.id,
    title: post.title,
    slug: post.slug,
    // A future publish date is scheduled (see publishedPostWhere in lib/news.ts)
    status: !post.publishedAt ? "draft" : post.publishedAt > now ? "scheduled" : "published",
    visibility: post.visibility,
    publishedAt: post.publishedAt,
    createdAt: post.createdAt,
    author: post.author ? { displayName: post.author.displayName, avatarUrl: post.author.avatarUrl } : null,
    tags: post.tags.map((tag) => ({ id: tag.id, name: tag.name })),
  }))

  const drafts = rows.filter((row) => row.status === "draft").length
  const scheduled = rows.filter((row) => row.status === "scheduled").length
  const summary = [
    `${rows.length} ${rows.length === 1 ? "post" : "posts"}`,
    drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"}` : null,
    scheduled ? `${scheduled} scheduled` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <PageHeader
        title="News"
        description={summary}
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/news/new">
              <Plus aria-hidden />
              New post
            </Link>
          </Button>
        }
      />
      <NewsConsole posts={rows} />
    </>
  )
}
