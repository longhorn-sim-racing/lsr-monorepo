import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { ExternalLink } from "lucide-react"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"
import { Button, PageHeader } from "@/components/admin/kit"
import { PostForm } from "../_components/post-form"

export const metadata: Metadata = { title: "Edit post" }

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditPostPage({ params }: PageProps) {
  await requireOfficerPage()
  const { id } = await params

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      author: { select: { id: true, displayName: true, handle: true, email: true, avatarUrl: true, eid: true } },
    },
  })

  if (!post) {
    notFound()
  }

  // Tags live in EntityTag, keyed by entity type and id
  const [entityTags, tags] = await Promise.all([
    prisma.entityTag.findMany({
      where: { entityType: "post", entityId: id },
      include: { tag: true },
    }),
    prisma.tag.findMany({
      select: { name: true },
      orderBy: { name: "asc" },
    }),
  ])

  // Transform to schema shape
  const postData = {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt ?? "",
    coverImageUrl: post.coverImageUrl,
    bodyMd: post.bodyMd,
    authorId: post.authorId ?? "",
    publishedAt: post.publishedAt,
    tags: entityTags.map((et) => et.tag.name),
  }

  const published = !!post.publishedAt && post.publishedAt <= new Date()

  return (
    <>
      <PageHeader
        title={post.title}
        description={`Last saved ${formatInTimeZone(post.updatedAt, DEFAULT_TIMEZONE, "MMM d, yyyy, h:mm a")} ${zoneLabel(post.updatedAt, DEFAULT_TIMEZONE)}`}
        back={{ href: "/admin/news", label: "News" }}
        actions={
          <Button asChild>
            <Link href={`/news/${post.slug}`} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              {published ? "View on site" : "Preview"}
            </Link>
          </Button>
        }
      />
      <PostForm post={postData} author={post.author} availableTags={tags.map((t) => t.name)} />
    </>
  )
}
