"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { Pencil } from "lucide-react"
import { toast } from "sonner"
import type { Visibility } from "@prisma/client"
import {
  Badge,
  Button,
  CellStack,
  DataTable,
  EmptyState,
  IconButton,
  RowActions,
  RowMenu,
  Segmented,
  type Column,
  type Tone,
} from "@/components/admin/kit"
import { deletePost } from "@/app/admin/news/actions"
import { DEFAULT_TIMEZONE, zoneLabel } from "@/lib/dates"
import { unexpectedError } from "@/lib/action-result"

export type NewsStatus = "draft" | "scheduled" | "published"

/** One post in the admin list (just what the list shows). */
export type NewsRow = {
  id: string
  title: string
  slug: string
  status: NewsStatus
  visibility: Visibility
  publishedAt: Date | null
  createdAt: Date
  author: { displayName: string; avatarUrl: string | null } | null
  tags: { id: string; name: string }[]
}

const STATUS: Record<NewsStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "info" },
  published: { label: "Published", tone: "success" },
}

const VISIBILITY_LABEL: Partial<Record<Visibility, string>> = { members: "Members only", officers: "Officers only" }

type View = "all" | NewsStatus

function PostDate({ post }: { post: NewsRow }) {
  if (!post.publishedAt) {
    return <span className="text-admin-subtle">Created {formatInTimeZone(post.createdAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}</span>
  }
  if (post.status === "scheduled") {
    return (
      <span>
        {formatInTimeZone(post.publishedAt, DEFAULT_TIMEZONE, "MMM d, yyyy, h:mm a")} {zoneLabel(post.publishedAt, DEFAULT_TIMEZONE)}
      </span>
    )
  }
  return <span>{formatInTimeZone(post.publishedAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}</span>
}

const columns: Column<NewsRow>[] = [
  {
    id: "title",
    header: "Post",
    sortValue: (post) => post.title,
    cell: (post) => (
      <CellStack
        primary={
          <Link href={`/admin/news/${post.id}`} className="hover:underline">
            {post.title}
          </Link>
        }
        secondary={`/news/${post.slug}`}
      />
    ),
    className: "max-w-[340px]",
  },
  {
    id: "author",
    header: "Author",
    hideBelow: "md",
    sortValue: (post) => post.author?.displayName,
    cell: (post) =>
      post.author ? (
        <span className="flex min-w-0 items-center gap-2">
          {post.author.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- avatar URLs can come from any host, which next/image would reject
            <img src={post.author.avatarUrl} alt="" className="size-5 shrink-0 rounded-full border" />
          )}
          <span className="truncate">{post.author.displayName}</span>
        </span>
      ) : (
        <span className="text-admin-subtle">No author</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (post) => ["draft", "scheduled", "published"].indexOf(post.status),
    cell: (post) => (
      <span className="flex flex-wrap items-center gap-1">
        <Badge tone={STATUS[post.status].tone}>{STATUS[post.status].label}</Badge>
        {VISIBILITY_LABEL[post.visibility] && <Badge tone="warning">{VISIBILITY_LABEL[post.visibility]}</Badge>}
      </span>
    ),
  },
  {
    id: "tags",
    header: "Tags",
    hideBelow: "lg",
    cell: (post) =>
      post.tags.length ? (
        <span className="flex max-w-[220px] flex-wrap gap-1">
          {post.tags.map((tag) => (
            <span key={tag.id} className="rounded border bg-admin-surface px-1.5 text-xs text-muted-foreground">
              {tag.name}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-admin-subtle">None</span>
      ),
  },
  {
    id: "date",
    header: "Date",
    sortValue: (post) => post.publishedAt ?? post.createdAt,
    cell: (post) => <PostDate post={post} />,
    className: "whitespace-nowrap",
  },
]

/** The news list: search, filter by status, sort, and edit or delete posts. */
export function NewsConsole({ posts }: { posts: NewsRow[] }) {
  const router = useRouter()
  const [view, setView] = useState<View>("all")

  const counts = useMemo(() => {
    const by = { draft: 0, scheduled: 0, published: 0 }
    for (const post of posts) by[post.status]++
    return by
  }, [posts])

  const rows = view === "all" ? posts : posts.filter((post) => post.status === view)

  const remove = async (post: NewsRow) => {
    try {
      await deletePost(post.id)
      toast.success(`Deleted "${post.title}"`)
      router.refresh()
    } catch (error) {
      toast.error(unexpectedError(error, "Couldn't delete the post"))
    }
  }

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(post) => post.id}
      search={{
        placeholder: "Search posts",
        text: (post) => `${post.title} ${post.slug} ${post.author?.displayName ?? ""} ${post.tags.map((tag) => tag.name).join(" ")}`,
      }}
      filters={
        <Segmented
          label="Status"
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: "All", count: posts.length },
            { value: "published", label: "Published", count: counts.published },
            { value: "scheduled", label: "Scheduled", count: counts.scheduled },
            { value: "draft", label: "Drafts", count: counts.draft },
          ]}
        />
      }
      rowHref={(post) => `/admin/news/${post.id}`}
      initialSort={{ id: "date", desc: true }}
      noun={{ one: "post", many: "posts" }}
      empty={
        view === "all" ? (
          <EmptyState
            title="No posts yet"
            description="Write the first announcement or recap for the news page."
            action={
              <Button variant="primary" asChild>
                <Link href="/admin/news/new">New post</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState title={`No ${view === "draft" ? "drafts" : `${view} posts`}`} description="Pick another status to see more posts." />
        )
      }
      rowActions={(post) => (
        <RowActions>
          <IconButton label={`Edit ${post.title}`} asChild>
            <Link href={`/admin/news/${post.id}`}>
              <Pencil />
            </Link>
          </IconButton>
          <RowMenu
            label={`More actions for ${post.title}`}
            items={[
              { label: post.status === "published" ? "View on site" : "Preview on site", href: `/news/${post.slug}`, external: true },
              "separator",
              {
                label: "Delete",
                destructive: {
                  title: `Delete "${post.title}"?`,
                  description: "The post comes off the news page and its link stops working. This can't be undone.",
                },
                onSelect: () => remove(post),
              },
            ]}
          />
        </RowActions>
      )}
    />
  )
}
