"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button, useConfirm } from "@/components/admin/kit"
import { disconnectTwitchAction } from "./actions"

/** Disconnects the club's Twitch account (admins), after asking */
export function DisconnectTwitchButton() {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect the club's Twitch account?",
      description: "The follower count stops updating, and the Twitch connection shows as not set up until an admin connects the club account again. Streams and VOD views already saved stay.",
      confirmLabel: "Disconnect",
      tone: "danger",
    })
    if (!ok) return
    start(async () => {
      try {
        const result = await disconnectTwitchAction()
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(result.data.revoked ? "Disconnected, and Twitch revoked the token" : "Disconnected")
        router.refresh()
      } catch {
        toast.error("Couldn't disconnect. Try again.")
      }
    })
  }

  return (
    <Button size="sm" variant="danger" onClick={disconnect} pending={pending}>
      Disconnect
    </Button>
  )
}
