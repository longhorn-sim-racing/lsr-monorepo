"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ExternalLink, Eye, EyeOff, Film, Layers, RefreshCw } from "lucide-react"
import {
  Badge,
  Button,
  DetailList,
  EmptyState,
  Field,
  IconButton,
  Input,
  Notice,
  Panel,
  PanelBody,
  PanelHeader,
  useConfirm,
} from "@/components/admin/kit"
import { CloudinaryImage } from "@/components/cloudinary-image"
import { cn } from "@/lib/utils"
import { connectInstagramAction, disconnectInstagramAction, setInstagramPostHiddenAction, syncInstagramAction } from "./actions"

type Status = {
  connected: boolean
  username: string | null
  lastSync: string | null
  tokenExpires: string | null
  lastError: string | null
  lastErrorAt: string | null
}

type Post = {
  id: string
  permalink: string
  caption: string | null
  mediaType: string
  publicId: string | null
  hidden: boolean
  postedAt: string
}

function syncSummary(result: { added: number; removed: number; error?: string }) {
  if (result.error) return result.error
  const parts = [`${result.added} new`]
  if (result.removed) parts.push(`${result.removed} removed`)
  return `Up to date (${parts.join(", ")})`
}

export function InstagramAdmin({ status, imagesReady, posts }: { status: Status; imagesReady: boolean; posts: Post[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startTransition] = useTransition()
  // What the running action is for ("connect", "sync", "disconnect" or a post id), to show its spinner
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const busy = pending ? busyKey : null
  const [token, setToken] = useState("")
  const [replacing, setReplacing] = useState(false)

  function run(key: string, action: () => Promise<void>) {
    setBusyKey(key)
    startTransition(async () => {
      await action()
      router.refresh()
    })
  }

  function connect() {
    run("connect", async () => {
      try {
        const result = await connectInstagramAction(token)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        setToken("")
        setReplacing(false)
        toast.success(`Connected @${result.username}. ${syncSummary(result.sync)}`)
      } catch {
        toast.error("Something went wrong. If it says connected after a refresh, it worked.")
      }
    })
  }

  function sync() {
    run("sync", async () => {
      try {
        const result = await syncInstagramAction()
        if (result.ok) toast.success(syncSummary(result))
        else toast.error(result.error ?? "Not connected")
      } catch {
        toast.error("The check didn't finish. It runs again on its own within the hour.")
      }
    })
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect Instagram?",
      description: "New posts stop coming in. Posts already on the site stay until you hide them.",
      confirmLabel: "Disconnect",
      tone: "danger",
    })
    if (!ok) return
    run("disconnect", async () => {
      try {
        await disconnectInstagramAction()
        toast.success("Disconnected")
      } catch {
        toast.error("Couldn't disconnect. Try again.")
      }
    })
  }

  function toggleHidden(post: Post) {
    run(post.id, async () => {
      try {
        const result = await setInstagramPostHiddenAction(post.id, !post.hidden)
        if (!result.ok) toast.error(result.error)
      } catch {
        toast.error("Couldn't update that post. Try again.")
      }
    })
  }

  const showConnectForm = !status.connected || replacing
  const hiddenCount = posts.filter((post) => post.hidden).length

  return (
    <div className="flex flex-col gap-4">
      {!imagesReady && (
        <Notice tone="warning" title="Images can't be copied yet">
          This server needs <code className="font-mono text-xs">CLOUDINARY_API_KEY</code> and <code className="font-mono text-xs">CLOUDINARY_API_SECRET</code> in its
          environment. Ask the Tech Team.
        </Notice>
      )}

      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-2">
              Connection
              {status.connected ? <Badge tone="success">Connected</Badge> : <Badge>Not connected</Badge>}
            </span>
          }
          actions={
            status.connected ? (
              <>
                <Button onClick={sync} disabled={pending}>
                  <RefreshCw className={cn(busy === "sync" && "animate-spin")} aria-hidden />
                  Check now
                </Button>
                <Button variant="danger" onClick={disconnect} disabled={pending} pending={busy === "disconnect"}>
                  Disconnect
                </Button>
              </>
            ) : undefined
          }
        />
        <PanelBody className="flex flex-col gap-4">
          {status.connected ? (
            <DetailList
              items={[
                { label: "Account", value: `@${status.username}` },
                { label: "Last checked", value: status.lastSync ?? "Not checked yet" },
                ...(status.tokenExpires
                  ? [{ label: "Access", value: `Renews itself every week. If renewing ever stops, it runs out on ${status.tokenExpires}.` }]
                  : []),
              ]}
            />
          ) : (
            <p className="text-[13px] text-muted-foreground">Follow the Instagram setup guide, then paste the access token it gives you below.</p>
          )}

          {status.lastError && (
            <Notice tone="danger" title="The last check failed">
              {status.lastError}
              {status.lastErrorAt && ` (${status.lastErrorAt})`}
            </Notice>
          )}

          {showConnectForm ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                connect()
              }}
            >
              <Field label="Access token" htmlFor="instagram-token" hint="It's stored on the server and never shown again.">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="instagram-token"
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Paste the token from the Meta dashboard"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" variant="primary" disabled={pending || !token.trim()} pending={busy === "connect"}>
                      Connect
                    </Button>
                    {replacing && (
                      <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              </Field>
            </form>
          ) : (
            <div>
              <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setReplacing(true)}>
                Paste a new access token
              </Button>
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Posts"
          description="The 8 newest visible posts appear on the News page. Hide any you'd rather not show there."
          actions={
            posts.length > 0 ? (
              <span className="text-xs text-admin-subtle">
                {posts.length} copied{hiddenCount > 0 && ` · ${hiddenCount} hidden`}
              </span>
            ) : undefined
          }
        />
        {posts.length === 0 ? (
          <EmptyState
            title="No posts copied yet"
            description={status.connected ? "Use Check now to pull the latest posts." : "Connect the club account to start copying posts."}
          />
        ) : (
          <PanelBody>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {posts.map((post) => (
                <li key={post.id} className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-card">
                  <div className={cn("relative aspect-square bg-admin-surface", post.hidden && "opacity-50")}>
                    {post.publicId ? (
                      <CloudinaryImage publicId={post.publicId} alt="" fill sizes="200px" className="object-cover" />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-admin-subtle">Image not copied yet</span>
                    )}
                    {post.mediaType === "VIDEO" && (
                      <Badge className="absolute right-1.5 top-1.5">
                        <Film className="size-3" aria-hidden />
                        Video
                      </Badge>
                    )}
                    {post.mediaType === "CAROUSEL_ALBUM" && (
                      <Badge className="absolute right-1.5 top-1.5">
                        <Layers className="size-3" aria-hidden />
                        Album
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-admin-subtle">{post.postedAt}</span>
                      {post.hidden && <Badge tone="warning">Hidden</Badge>}
                    </div>
                    {post.caption && <p className="line-clamp-2 text-xs text-muted-foreground">{post.caption}</p>}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                      <Button size="sm" disabled={pending} pending={busy === post.id} onClick={() => toggleHidden(post)}>
                        {busy !== post.id && (post.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />)}
                        {post.hidden ? "Show" : "Hide"}
                      </Button>
                      <IconButton label="Open on Instagram" asChild>
                        <a href={post.permalink} target="_blank" rel="noopener noreferrer">
                          <ExternalLink />
                        </a>
                      </IconButton>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </PanelBody>
        )}
      </Panel>
    </div>
  )
}
