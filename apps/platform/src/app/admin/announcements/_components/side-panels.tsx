"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { Badge, Button, CheckboxField, Dialog, EmptyState, Panel, PanelBody, PanelHeader, Select } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { privacyNoteRequest } from "@/lib/discord/privacy-note"
import { setPostingChannelsAction } from "../actions"
import { ComposeDialog, type ChannelOption, type PingOption } from "./compose"

/** The channels the bot may post in. Admins pick them from the server's text and announcement channels */
export function ChannelsPanel({ allowed, choices, isAdmin }: { allowed: ChannelOption[]; choices: ChannelOption[]; isAdmin: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>(allowed.map((c) => c.id))
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    let result
    try {
      result = await setPostingChannelsAction(picked)
    } catch (error) {
      result = { ok: false as const, error: unexpectedError(error, "Couldn't save the channels") }
    }
    setSaving(false)
    if (!result.ok) return void toast.error(result.error)
    toast.success("Posting channels saved")
    setOpen(false)
    router.refresh()
  }

  return (
    <Panel>
      <PanelHeader
        title="Posting channels"
        description="The only channels the bot posts in: standing rules, Jack's proposals, officers' posts and the weekly digest alike."
        actions={
          isAdmin ? (
            <Button
              size="sm"
              onClick={() => {
                setPicked(allowed.map((c) => c.id))
                setOpen(true)
              }}
            >
              Change
            </Button>
          ) : undefined
        }
      />
      <PanelBody>
        {allowed.length ? (
          <div className="flex flex-wrap gap-1.5">
            {allowed.map((c) => (
              <Badge key={c.id}>#{c.name}</Badge>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">None yet, so nothing can be posted. {isAdmin ? "Pick one or two (an announcements channel, say)." : "An admin picks them."}</p>
        )}
      </PanelBody>
      {open && (
        <Dialog
          open
          onOpenChange={(next) => !next && setOpen(false)}
          title="Posting channels"
          description="Text and announcement channels from the last Discord sync. Removing one cancels what's scheduled there when it comes due."
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" pending={saving} onClick={() => void save()}>
                Save
              </Button>
            </>
          }
        >
          {choices.length ? (
            <div className="flex flex-col gap-2">
              {choices.map((c) => (
                <CheckboxField key={c.id} label={`#${c.name}`} checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((id) => id !== c.id)))} />
              ))}
            </div>
          ) : (
            <EmptyState title="No channels yet" description="The channel list comes from the Discord sync. Switch Discord on and let it run once." />
          )}
        </Dialog>
      )}
    </Panel>
  )
}

/**
 * The server privacy note (design §12.1), filled in with the channels that sync now. "Copy for Jack"
 * copies a request to paste into a room, so Jack proposes it as a discord.post for an officer to apply;
 * an officer can also post it themselves. Nothing posts it on its own
 */
export function PrivacyNotePanel({ text, readable, syncedChannels, channels, pings }: { text: string; readable: string; syncedChannels: string[]; channels: ChannelOption[]; pings: PingOption[] }) {
  const preferred = channels.find((c) => /announce|rules|info/i.test(c.name)) ?? channels[0]
  const [channelId, setChannelId] = useState(preferred?.id ?? "")
  const [composing, setComposing] = useState(false)
  const channel = channels.find((c) => c.id === channelId)

  async function copy() {
    if (!channel) return
    try {
      await navigator.clipboard.writeText(privacyNoteRequest(text, channel.name))
      toast.success("Copied. Paste it into a Jack room; an officer applies the card.")
    } catch {
      toast.error("Couldn't copy it. Select the text and copy it yourself.")
    }
  }

  return (
    <Panel>
      <PanelHeader title="Server privacy note" description={`Tells members what the bot keeps. Post it again when the synced channels change (now: ${syncedChannels.length ? syncedChannels.map((c) => `#${c}`).join(", ") : "none"}).`} />
      <PanelBody className="flex flex-col gap-3">
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-admin-surface px-3 py-2 text-xs text-muted-foreground">{readable}</p>
        {channels.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Channel for the note" value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-auto">
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => void copy()}>
              <Copy aria-hidden />
              Copy for Jack
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setComposing(true)}>
              Post it myself
            </Button>
          </div>
        ) : (
          <p className="text-xs text-admin-subtle">Pick a posting channel first.</p>
        )}
      </PanelBody>
      {composing && <ComposeDialog channels={channels} pings={pings} defaults={{ channelId, text }} onClose={() => setComposing(false)} />}
    </Panel>
  )
}
