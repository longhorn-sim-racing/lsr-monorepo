"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  DetailList,
  Field,
  FormActions,
  Input,
  Notice,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  SwitchField,
  useConfirm,
} from "@/components/admin/kit"
import { updateEmailSettings } from "../actions"

type EmailSettings = {
  enabled: boolean
  fromAddress: string
}

export function NotificationSettings({ settings, resendKeyConfigured }: { settings: EmailSettings; resendKeyConfigured: boolean }) {
  const confirm = useConfirm()
  const [isPending, startTransition] = useTransition()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [fromAddress, setFromAddress] = useState(settings.fromAddress)

  const changed = enabled !== settings.enabled || fromAddress !== settings.fromAddress

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (settings.enabled && !enabled) {
      const ok = await confirm({
        tone: "danger",
        title: "Turn off all email?",
        description: "No notification emails go out, including registration confirmations and receipts, until it's turned back on. In-app notifications keep working.",
        confirmLabel: "Turn off email",
      })
      if (!ok) return
    }

    const formData = new FormData()
    formData.set("enabled", enabled ? "on" : "")
    formData.set("fromAddress", fromAddress)
    startTransition(async () => {
      try {
        await updateEmailSettings(formData)
        toast.success("Settings saved")
      } catch {
        toast.error("Failed to save settings")
      }
    })
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <form onSubmit={handleSubmit}>
        <Panel>
          <PanelHeader title="Email" description="Applies to every email the notification system sends." />
          <PanelBody className="flex flex-col gap-4">
            <SwitchField
              label="Send email notifications"
              description="The master switch for outbound email. When it's off, no emails are sent from the notification system."
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            {!enabled && (
              <Notice tone="warning" title="Email notifications are off">
                Members won&apos;t get any email notifications until this is turned back on. In-app notifications keep working.
              </Notice>
            )}
            <Field label="From address" htmlFor="settings-from-address" hint="Format: Display Name <email@domain.com>">
              <Input
                id="settings-from-address"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                placeholder="Longhorn Sim Racing <noreply@notify.longhornsimracing.org>"
              />
            </Field>
          </PanelBody>
          <PanelFooter>
            <FormActions className="w-full" note={changed ? "Unsaved changes" : undefined}>
              {changed && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEnabled(settings.enabled)
                    setFromAddress(settings.fromAddress)
                  }}
                  disabled={isPending}
                >
                  Discard
                </Button>
              )}
              <Button type="submit" variant="primary" pending={isPending} disabled={!changed}>
                Save settings
              </Button>
            </FormActions>
          </PanelFooter>
        </Panel>
      </form>

      <Panel>
        <PanelHeader title="Environment" description="Set in the deployment, not here." />
        <PanelBody>
          <DetailList
            items={[
              { label: "Email provider", value: "Resend" },
              {
                label: "API key",
                value: resendKeyConfigured ? <Badge tone="success">Configured</Badge> : <Badge tone="danger">Missing</Badge>,
              },
              { label: "Sending domain", value: "notify.longhornsimracing.org" },
            ]}
          />
        </PanelBody>
      </Panel>
    </div>
  )
}
