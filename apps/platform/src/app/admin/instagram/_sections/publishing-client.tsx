"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button, DetailList, Field, Input, useConfirm } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { checkInstagramPublishNow, connectInstagramPublishing, disconnectInstagramPublishing } from "../publish-actions"

export type PublishConnection = {
  connected: boolean
  username: string | null
  connectedAt: string | null
  tokenExpires: string | null
  refreshError: string | null
}

/**
 * The publishing token on Content → Instagram: whose it is and when it runs out, and for admins the
 * form to paste one (or replace it) and Disconnect. Officers see it read-only.
 */
export function PublishConnectionPanel({ connection, isAdmin }: { connection: PublishConnection; isAdmin: boolean }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)
  const [token, setToken] = useState("")
  const [replacing, setReplacing] = useState(false)

  function connect() {
    setBusy("connect")
    start(async () => {
      try {
        const result = await connectInstagramPublishing(token)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        setToken("")
        setReplacing(false)
        toast.success(`Publishing connected for @${result.data.username}. An admin switches it on in System → Connections.`)
        router.refresh()
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't save the token"))
      }
    })
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect Instagram publishing?",
      description: "Nothing more can be posted from the site until an admin pastes a token again. Posts already up stay on Instagram, and the history stays here.",
      confirmLabel: "Disconnect",
      tone: "danger",
    })
    if (!ok) return
    setBusy("disconnect")
    start(async () => {
      try {
        const result = await disconnectInstagramPublishing()
        if (!result.ok) toast.error(result.error)
        else toast.success("Disconnected")
        router.refresh()
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't disconnect"))
      }
    })
  }

  const showForm = isAdmin && (!connection.connected || replacing)
  return (
    <div className="flex flex-col gap-3">
      {connection.connected ? (
        <DetailList
          items={[
            { label: "Posts as", value: connection.username ? `@${connection.username}` : "Unknown account" },
            ...(connection.connectedAt ? [{ label: "Connected", value: connection.connectedAt }] : []),
            { label: "Token", value: connection.tokenExpires ? `Its own (not the feed's). Renewed weekly; runs out ${connection.tokenExpires} if renewing stops.` : "Its own (not the feed's). Renewed weekly." },
          ]}
        />
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {isAdmin
            ? "Paste a token from the club's publishing app (a second Meta app with instagram_business_content_publish), generated signed in as the club account. The steps are in the Jack 2.0 docs (decks-rooms)."
            : "Not connected. An admin pastes the publishing token here."}
        </p>
      )}

      {showForm ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            connect()
          }}
        >
          <Field label="Publishing token" htmlFor="instagram-publish-token" hint="Checked with Instagram, stored on the server, and never shown again.">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="instagram-publish-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the publishing app's token" />
              <div className="flex gap-2">
                <Button type="submit" variant="primary" pending={pending && busy === "connect"} disabled={!token.trim() || pending}>
                  {connection.connected ? "Replace" : "Connect"}
                </Button>
                {replacing && (
                  <Button type="button" onClick={() => setReplacing(false)} disabled={pending}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </Field>
        </form>
      ) : (
        isAdmin &&
        connection.connected && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setReplacing(true)} disabled={pending}>
              Replace token
            </Button>
            <Button size="sm" variant="danger" onClick={disconnect} pending={pending && busy === "disconnect"} disabled={pending}>
              Disconnect
            </Button>
          </div>
        )
      )}
    </div>
  )
}

/** "Check now" on a post still waiting on Instagram: the same steps the follow-up job takes, right away */
export function CheckPublishButton({ id }: { id: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()

  function check() {
    start(async () => {
      try {
        const result = await checkInstagramPublishNow(id)
        if (!result.ok) toast.error(result.error)
        else if (result.data.status === "published") toast.success("It's up on Instagram")
        else if (result.data.status === "failed") toast.error("It couldn't be posted; the history says why")
        else toast.info("Instagram is still processing it; it's checked again within 5 minutes")
        router.refresh()
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't check it"))
      }
    })
  }

  return (
    <Button size="sm" variant="ghost" onClick={check} pending={pending}>
      <RefreshCw aria-hidden />
      Check now
    </Button>
  )
}
