"use client"

import { useState, useTransition } from "react"
import { fromZonedTime } from "date-fns-tz"
import { Bell, Send } from "lucide-react"
import { toast } from "sonner"
import {
  Button,
  CheckboxField,
  Field,
  FieldGrid,
  FormActions,
  FormSection,
  Input,
  Notice,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Select,
  SplitLayout,
  SwitchField,
  Textarea,
  UserMultiPicker,
  UserPicker,
  useConfirm,
  type AdminUserOption,
} from "@/components/admin/kit"
import { searchUsersForAdmin } from "@/server/actions/admin-user-search"
import { unexpectedError } from "@/lib/action-result"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { sendCustomNotification } from "../actions"
import { centralTime, plural } from "./format"

type RecipientType = "single" | "multiple" | "all"

/** Announcements only go to active members, like "All active members" */
const searchActiveMembers = (query: string) => searchUsersForAdmin(query, { activeOnly: true })

export function NotificationComposer({
  emailUsage,
  keptForReceipts,
}: {
  emailUsage: { sentToday: number; dailyLimit: number | null }
  keptForReceipts: number
}) {
  const confirm = useConfirm()
  const [isPending, startTransition] = useTransition()
  const [recipientType, setRecipientType] = useState<RecipientType>("single")
  const [selectedUsers, setSelectedUsers] = useState<AdminUserOption[]>([])
  const [sendInApp, setSendInApp] = useState(true)
  const [sendEmail, setSendEmail] = useState(true)
  const [sendAnyway, setSendAnyway] = useState(false)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [actionUrl, setActionUrl] = useState("")
  const [actionText, setActionText] = useState("")
  const [scheduled, setScheduled] = useState(false)
  const [scheduledFor, setScheduledFor] = useState("")

  const { sentToday, dailyLimit } = emailUsage
  const emailsLeft = dailyLimit === null ? null : Math.max(0, dailyLimit - sentToday - keptForReceipts)
  const showSendAnyway = sendEmail && dailyLimit !== null && !scheduled

  // datetime-local has no zone; it's read as Central, like the server does
  const scheduledDate = scheduled && scheduledFor ? fromZonedTime(scheduledFor, DEFAULT_TIMEZONE) : null
  const scheduleError = scheduled && scheduledDate && scheduledDate.getTime() <= Date.now() ? "Pick a time in the future." : undefined

  const needsMembers = recipientType === "single" || recipientType === "multiple"
  const blockedReason =
    !sendInApp && !sendEmail
      ? "Pick at least one channel."
      : needsMembers && selectedUsers.length === 0
        ? "Add at least one recipient."
        : !title.trim() || !body.trim()
          ? "Write a title and a message."
          : scheduled && !scheduledFor
            ? "Pick when to send it."
            : scheduleError

  const changeRecipientType = (next: RecipientType) => {
    setRecipientType(next)
    // Clear selection when switching types
    if (next === "all") setSelectedUsers([])
    if (next === "single" && selectedUsers.length > 1) setSelectedUsers(selectedUsers.slice(0, 1))
  }

  const reset = () => {
    setSelectedUsers([])
    setTitle("")
    setBody("")
    setActionUrl("")
    setActionText("")
    setScheduled(false)
    setScheduledFor("")
    setSendAnyway(false)
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (blockedReason || isPending) return

    if (recipientType === "all") {
      const channels = [sendInApp && "in-app", sendEmail && "email"].filter(Boolean).join(" and ")
      const ok = await confirm({
        title: scheduledDate ? "Schedule this for every active member?" : "Send this to every active member?",
        description: scheduledDate
          ? `It goes out by ${channels} on ${centralTime(scheduledDate, "MMM d 'at' h:mm a")}. You can cancel it from Scheduled until then.`
          : `It goes out by ${channels} right away and can't be unsent.`,
        confirmLabel: scheduledDate ? "Schedule" : "Send to everyone",
      })
      if (!ok) return
    }

    const formData = new FormData()
    formData.set("recipientType", recipientType)
    if (needsMembers && selectedUsers.length > 0) formData.set("userIds", JSON.stringify(selectedUsers.map((u) => u.id)))
    formData.set("title", title)
    formData.set("body", body)
    if (actionUrl.trim()) formData.set("actionUrl", actionUrl.trim())
    if (actionText.trim()) formData.set("actionText", actionText.trim())
    if (sendInApp) formData.set("sendInApp", "on")
    if (sendEmail) formData.set("sendEmail", "on")
    if (scheduled && scheduledFor) formData.set("scheduledFor", scheduledFor)
    if (showSendAnyway && sendAnyway) formData.set("sendAnyway", "on")

    startTransition(async () => {
      try {
        const result = await sendCustomNotification(formData)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        const { scheduled: wasScheduled, recipients, emailsSent, emailsFailed } = result.data
        const who = recipientType === "all" ? "all members" : `${recipients} ${recipients === 1 ? "member" : "members"}`
        if (wasScheduled) toast.success(`Scheduled for ${who}`)
        else if (emailsFailed > 0) {
          toast.warning(`Sent to ${who}, but ${emailsFailed} of ${emailsSent + emailsFailed} emails failed. Check Activity before resending.`)
        } else toast.success(`Sent to ${who}${emailsSent ? ` (${emailsSent} ${emailsSent === 1 ? "email" : "emails"})` : ""}`)
        reset()
      } catch (error) {
        console.error(error)
        toast.error(unexpectedError(error, "Couldn't send the notification"))
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <SplitLayout
        main={
          <Panel>
            <PanelHeader title="New notification" description="A custom message to members, in the site's notification bell, by email, or both." />
            <PanelBody className="flex flex-col gap-6">
              <FormSection title="Recipients">
                <Field label="Send to" htmlFor="compose-recipient-type">
                  <Select id="compose-recipient-type" value={recipientType} onChange={(e) => changeRecipientType(e.target.value as RecipientType)}>
                    <option value="single">One member</option>
                    <option value="multiple">Several members</option>
                    <option value="all">All active members</option>
                  </Select>
                </Field>
                {recipientType === "single" && (
                  <Field label="Member" htmlFor="compose-member" hint="Active members only. Search by name, handle, email or EID.">
                    <UserPicker
                      id="compose-member"
                      value={selectedUsers[0] ?? null}
                      onChange={(user) => setSelectedUsers(user ? [user] : [])}
                      search={searchActiveMembers}
                      placeholder="Find a member"
                    />
                  </Field>
                )}
                {recipientType === "multiple" && (
                  <Field
                    label="Members"
                    hint={selectedUsers.length ? `${plural(selectedUsers.length, "member")} chosen` : "Active members only. Search by name, handle, email or EID."}
                  >
                    <UserMultiPicker value={selectedUsers} onChange={setSelectedUsers} search={searchActiveMembers} placeholder="Add members" />
                  </Field>
                )}
                {recipientType === "all" && <Notice tone="warning">This goes to every active member.</Notice>}
              </FormSection>

              <FormSection title="Channels">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <CheckboxField label="In-app" description="The bell on the site" checked={sendInApp} onChange={(e) => setSendInApp(e.target.checked)} />
                  <CheckboxField
                    label="Email"
                    description="Skips members who turned announcement emails off"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                  />
                </div>
                {sendEmail && (
                  <Notice
                    tone={emailsLeft !== null && emailsLeft < 20 ? "warning" : "neutral"}
                    title={emailsLeft === null ? `${plural(sentToday, "email")} sent today` : `${plural(emailsLeft, "email")} left for announcements today`}
                  >
                    {dailyLimit === null ? (
                      "This email plan has no daily limit."
                    ) : (
                      <>
                        {sentToday} of {dailyLimit} daily emails sent today; the limit resets at 7 pm Central (6 pm in winter). An immediate send that
                        would go over is stopped first, keeping {keptForReceipts} for confirmations and receipts. Scheduled sends aren&apos;t checked.
                      </>
                    )}
                  </Notice>
                )}
                {showSendAnyway && (
                  <CheckboxField
                    label="Send anyway, even if it goes over"
                    description="Resend refuses emails past the limit, so some members may not get it, and confirmations and receipts won't go out until the reset."
                    checked={sendAnyway}
                    onChange={(e) => setSendAnyway(e.target.checked)}
                  />
                )}
              </FormSection>

              <FormSection title="Message">
                <Field label="Title" htmlFor="compose-title" required>
                  <Input id="compose-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="GM 1 is Monday" />
                </Field>
                <Field label="Message" htmlFor="compose-body" required>
                  <Textarea id="compose-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What members need to know" />
                </Field>
                <FieldGrid>
                  <Field label="Link" htmlFor="compose-action-url" hint="Optional. Where the email button and the bell go.">
                    <Input id="compose-action-url" value={actionUrl} onChange={(e) => setActionUrl(e.target.value)} placeholder="/events/general-meeting-1" />
                  </Field>
                  <Field label="Button text" htmlFor="compose-action-text" hint="Optional. Defaults to View Details.">
                    <Input id="compose-action-text" value={actionText} onChange={(e) => setActionText(e.target.value)} placeholder="View Details" />
                  </Field>
                </FieldGrid>
              </FormSection>

              <FormSection title="Delivery">
                <SwitchField
                  label="Schedule for later"
                  description="Off sends it as soon as you press Send."
                  checked={scheduled}
                  onCheckedChange={(on) => {
                    setScheduled(on)
                    if (!on) setScheduledFor("")
                  }}
                />
                {scheduled && (
                  <Field label="Send at (Central)" htmlFor="compose-scheduled-for" error={scheduleError} hint={scheduledDate ? centralTime(scheduledDate, "EEEE, MMM d 'at' h:mm a") : undefined}>
                    <Input
                      id="compose-scheduled-for"
                      type="datetime-local"
                      value={scheduledFor}
                      onChange={(e) => setScheduledFor(e.target.value)}
                      aria-invalid={!!scheduleError}
                      className="sm:max-w-64"
                    />
                  </Field>
                )}
              </FormSection>
            </PanelBody>
            <PanelFooter>
              <FormActions className="w-full" note={blockedReason}>
                <Button type="submit" variant="primary" pending={isPending} disabled={!!blockedReason}>
                  {!isPending && <Send aria-hidden />}
                  {scheduled ? "Schedule" : "Send now"}
                </Button>
              </FormActions>
            </PanelFooter>
          </Panel>
        }
        side={
          <Panel>
            <PanelHeader title="Preview" description="Roughly how it reads in the bell and the email." />
            <PanelBody>
              <div className="flex gap-3 rounded-md border bg-admin-surface p-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-card text-admin-subtle">
                  <Bell className="size-4" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={title.trim() ? "break-words font-semibold" : "font-semibold text-admin-subtle"}>{title.trim() || "Title"}</p>
                  <p className={body.trim() ? "whitespace-pre-wrap break-words text-muted-foreground" : "text-admin-subtle"}>{body.trim() || "Message"}</p>
                  {actionUrl.trim() && (
                    <span className="mt-1 w-fit rounded-md border bg-card px-2.5 py-1 text-xs font-semibold">{actionText.trim() || "View Details"}</span>
                  )}
                </div>
              </div>
              <p className="mt-3 text-xs text-admin-subtle">
                {recipientType === "all"
                  ? "To every active member"
                  : selectedUsers.length
                    ? `To ${selectedUsers.map((u) => u.displayName).join(", ")}`
                    : "No recipients yet"}
                {" · "}
                {[sendInApp && "In-app", sendEmail && "Email"].filter(Boolean).join(" and ") || "No channel"}
                {" · "}
                {scheduledDate ? centralTime(scheduledDate, "MMM d, h:mm a") : "Sends right away"}
              </p>
            </PanelBody>
          </Panel>
        }
      />
    </form>
  )
}
