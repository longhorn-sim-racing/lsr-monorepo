"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button, Field, Input, useConfirm } from "@/components/admin/kit"
import type { PurgeResult } from "@/server/services/discord-link.service"
import { purgeDiscordMemberAction } from "./actions"
import type { PurgeRoles } from "@/server/discord-post/role-takeback"

const done = ({ messages, threads, unlinkedUserId }: PurgeResult) =>
  `Deleted ${messages} message ${messages === 1 ? "record" : "records"}${threads ? `, ${threads} thread ${threads === 1 ? "title" : "titles"}` : ""}${unlinkedUserId ? " and the member's account link" : ""}. They won't be collected again.`

const CONFIRM = {
  description:
    "Their message records, their member record, the titles of threads they started and any account link are deleted, and the sync never collects them again. Daily totals are recounted without them. This can't be undone.",
  confirmLabel: "Delete their data",
  tone: "danger" as const,
}

/** Community → Discord: delete someone's Discord data on request, by Discord user ID or username (admins) */
export function PurgeForm() {
  const router = useRouter()
  const confirm = useConfirm()
  const [who, setWho] = useState("")
  const [pending, startPurge] = useTransition()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = who.trim()
    if (!value) return
    if (!(await confirm({ title: `Delete the Discord data of ${/^\d+$/.test(value) ? `user ${value}` : `@${value.replace(/^@/, "")}`}?`, ...CONFIRM }))) return
    startPurge(async () => {
      try {
        const result = await purgeDiscordMemberAction(/^\d+$/.test(value) ? { discordUserId: value } : { username: value })
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(done(result.data))
        setWho("")
        router.refresh()
        rolesToast(result.data.roles)
      } catch {
        toast.error("Couldn't delete it. Try again.")
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <Field label="Discord user ID or username" htmlFor="discord-purge" hint="For someone who asks the club to delete their Discord data." className="min-w-0 flex-1">
        <Input id="discord-purge" value={who} onChange={(e) => setWho(e.target.value)} placeholder="e.g. 112233445566778899 or avery.reyes" autoComplete="off" spellCheck={false} />
      </Field>
      {/* Level with the input, past the field's label */}
      <Button type="submit" variant="danger" pending={pending} disabled={!who.trim()} className="sm:mt-[22px]">
        Delete their data
      </Button>
    </form>
  )
}

/** Members → edit: the same, for a member's linked Discord account (admins) */
export function PurgeLinkedButton({ userId, username }: { userId: string; username: string | null }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startPurge] = useTransition()

  async function purge() {
    if (!(await confirm({ title: `Delete ${username ? `@${username}'s` : "this member's"} Discord data?`, ...CONFIRM }))) return
    startPurge(async () => {
      try {
        const result = await purgeDiscordMemberAction({ userId })
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(done(result.data))
        router.refresh()
        rolesToast(result.data.roles)
      } catch {
        toast.error("Couldn't delete it. Try again.")
      }
    })
  }

  return (
    <Button size="sm" variant="danger" onClick={purge} pending={pending}>
      Delete Discord data
    </Button>
  )
}

/** What role sync took back from the account; when it couldn't, the admin removes the roles in Discord */
function rolesToast(roles: PurgeRoles) {
  if (!roles) return
  if (roles.error) toast.warning(`Role sync couldn't take back the roles it gave them${roles.taken.length ? ` (it took ${roles.taken.join(", ")})` : ""}: ${roles.error.replace(/\.?$/, ".")} Remove its roles from them in Discord.`, { duration: 15_000 })
  else if (roles.taken.length) toast.success(`Role sync took back ${roles.taken.join(", ")}.`)
}
