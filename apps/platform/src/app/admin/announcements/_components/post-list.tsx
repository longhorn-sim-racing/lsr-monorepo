"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ExternalLink, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge, Button, Dialog, RowActions, RowMenu, Segmented, useConfirm, type RowMenuItem, type Tone } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import type { PostListView, PostView } from "@/server/discord-post/queries"
import { cancelPostAction, retryPostAction } from "../actions"

const STATUS: Record<PostView["status"], { label: string; tone: Tone }> = {
  SCHEDULED: { label: "Scheduled", tone: "info" },
  SENDING: { label: "Sending", tone: "warning" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
}

const VIEWS: { value: PostListView; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "sent", label: "Sent" },
  { value: "problems", label: "Failed and cancelled" },
  { value: "all", label: "All" },
]

/** Which posts the list shows; it lives in the URL (?view=) */
export function PostFilters({ view, counts }: { view: PostListView; counts: Record<PostListView, number> }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const go = (next: PostListView) => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("page")
    if (next === "scheduled") params.delete("view")
    else params.set("view", next)
    const query = params.toString()
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }))
  }
  return (
    <div className="flex items-center gap-2">
      <Segmented label="Posts" options={VIEWS.map((v) => ({ ...v, count: counts[v.value] }))} value={view} onChange={go} />
      {pending && <Loader2 className="size-4 animate-spin text-admin-subtle" aria-label="Loading" />}
    </div>
  )
}

async function run<T>(action: () => Promise<ActionResult<T>>, what: string): Promise<ActionResult<T>> {
  try {
    return await action()
  } catch (error) {
    return { ok: false, error: unexpectedError(error, what) }
  }
}

/** One post's whole message, as Discord gets it (mentions shown by name) */
function MessageView({ post }: { post: PostView }) {
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {post.text && <p className="whitespace-pre-wrap break-words">{post.text}</p>}
      {post.embed && (
        <div className="flex flex-col gap-1.5 rounded-md border-l-4 border-l-[var(--series-1)] bg-admin-surface px-3 py-2">
          {post.embed.title && <p className="font-semibold">{post.embed.title}</p>}
          {post.embed.description && <p className="whitespace-pre-wrap break-words text-muted-foreground">{post.embed.description}</p>}
          {post.embed.fields.map((field) => (
            <div key={field.name} className="flex flex-col">
              <span className="text-xs font-semibold">{field.name}</span>
              <span className="break-words text-muted-foreground">{field.value}</span>
            </div>
          ))}
        </div>
      )}
      {post.poll && (
        <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2">
          <p className="font-semibold">{post.poll.question}</p>
          <ul className="flex flex-col gap-1">
            {post.poll.answers.map((answer, i) => (
              <li key={i} className="rounded border border-admin-row px-2 py-1 text-muted-foreground">
                {answer}
              </li>
            ))}
          </ul>
          <p className="text-xs text-admin-subtle">Open {post.poll.hours % 24 === 0 ? `${post.poll.hours / 24} day${post.poll.hours === 24 ? "" : "s"}` : `${post.poll.hours} hour${post.poll.hours === 1 ? "" : "s"}`}</p>
        </div>
      )}
    </div>
  )
}

/** The outbox: each post with where it's going, when, where it came from, and what an officer can do */
export function PostList({ posts }: { posts: PostView[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<PostView | null>(null)

  async function cancel(post: PostView) {
    setBusy(post.id)
    const result = await run(() => cancelPostAction(post.id), "Couldn't cancel it")
    setBusy(null)
    if (!result.ok) return void toast.error(result.error)
    toast.success("Cancelled")
    router.refresh()
  }

  async function retry(post: PostView) {
    const ok = await confirm({
      title: `Send it to ${post.channel} again?`,
      description: "Look in the channel first: if the message is there, don't send it again. Discord catches a repeat only within a few minutes of the first try.",
      confirmLabel: "Send again",
    })
    if (!ok) return
    setBusy(post.id)
    const result = await run(() => retryPostAction(post.id), "Couldn't send it")
    setBusy(null)
    if (!result.ok) return void toast.error(result.error)
    toast.success(result.data.summary)
    router.refresh()
  }

  return (
    <>
      <ul className="flex flex-col">
        {posts.map((post) => {
          const status = STATUS[post.status]
          const menu: RowMenuItem[] = [
            { label: "Show the message", onSelect: () => setOpen(post) },
            ...(post.status === "SCHEDULED" ? [{ label: "Cancel it", onSelect: () => cancel(post), destructive: { title: "Cancel this post?", description: `It won't be posted in ${post.channel}. A rule won't post it again either.`, confirmLabel: "Cancel post", tone: "danger" as const } }] : []),
            ...(post.status === "FAILED" ? [{ label: "Send again", onSelect: () => retry(post) }] : []),
            ...(post.url ? [{ label: "Open in Discord", href: post.url, external: true }] : []),
          ]
          const preview = post.text || post.embed?.title || (post.poll ? `Poll: ${post.poll.question}` : "")
          return (
            <li key={post.id} className="flex items-start gap-3 border-b border-admin-row px-4 py-3 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="text-[13px] font-semibold">{post.channel}</span>
                  <span className="text-xs text-admin-subtle">{post.when}</span>
                  {post.ping && <Badge tone="warning">Pings {post.ping}</Badge>}
                </div>
                <button type="button" onClick={() => setOpen(post)} className="line-clamp-3 whitespace-pre-wrap break-words text-left text-[13px] text-muted-foreground hover:text-foreground">
                  {preview}
                  {post.poll && post.text ? ` · Poll: ${post.poll.question}` : ""}
                </button>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-admin-subtle">
                  <span>
                    From{" "}
                    {post.fromHref ? (
                      <Link href={post.fromHref} className="hover:text-foreground hover:underline">
                        {post.from}
                      </Link>
                    ) : (
                      post.from
                    )}
                  </span>
                  {post.url && (
                    <a href={post.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                      <ExternalLink className="size-3" aria-hidden />
                      Open in Discord
                    </a>
                  )}
                </div>
                {post.error && <p className={post.status === "FAILED" ? "text-xs text-tone-danger-foreground" : "text-xs text-admin-subtle"}>{post.error}</p>}
              </div>
              <RowActions>
                {post.status === "FAILED" && (
                  <Button size="sm" pending={busy === post.id} onClick={() => void retry(post)}>
                    Send again
                  </Button>
                )}
                <RowMenu label={`Options for the post in ${post.channel}`} items={menu} />
              </RowActions>
            </li>
          )
        })}
      </ul>
      {open && (
        <Dialog open onOpenChange={(next) => !next && setOpen(null)} title={`${STATUS[open.status].label} · ${open.channel}`} description={`${open.when} · from ${open.from}${open.ping ? ` · pings ${open.ping}` : " · pings nobody"}`}>
          <MessageView post={open} />
        </Dialog>
      )}
    </>
  )
}
