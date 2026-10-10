"use client";

import { useState, useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Mail, Loader2, Save } from "lucide-react";
import { updateEmailSettings } from "../actions";
import { toast } from "sonner";

type EmailSettings = {
  enabled: boolean;
  fromAddress: string;
};

export function NotificationSettings({ settings, resendKeyConfigured }: { settings: EmailSettings; resendKeyConfigured: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [fromAddress, setFromAddress] = useState(settings.fromAddress);

  const handleSubmit = async (formData: FormData) => {
    startTransition(async () => {
      try {
        await updateEmailSettings(formData);
        toast.success("Settings saved");
      } catch {
        toast.error("Failed to save settings");
      }
    });
  };

  return (
    <form action={handleSubmit} className="space-y-6">
      {/* Master Switch */}
      <div className="border border-white/10 bg-white/[0.02] p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <Mail className="h-5 w-5 text-lsr-orange" />
              <h3 className="text-lg font-bold text-white">Email Notifications</h3>
            </div>
            <p className="text-sm text-white/50 mt-2 max-w-md">
              Master switch for all outbound email notifications. When disabled, no
              emails will be sent from the notification system.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <input type="hidden" name="enabled" value={enabled ? "on" : ""} />
            <span
              className={`text-xs font-bold uppercase tracking-wider ${enabled ? "text-green-500" : "text-red-500"}`}
            >
              {enabled ? "Enabled" : "Disabled"}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              className="data-[state=checked]:bg-lsr-orange"
            />
          </div>
        </div>

        {!enabled && (
          <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/30 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-yellow-500 font-bold">
                Email notifications are disabled
              </p>
              <p className="text-xs text-yellow-500/80 mt-1">
                Users will not receive any email notifications until this is
                re-enabled. In-app notifications will continue to work.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* From Address */}
      <div className="border border-white/10 bg-white/[0.02] p-6">
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-bold text-white">From Address</h3>
            <p className="text-sm text-white/50 mt-1">
              The sender address for notification emails
            </p>
          </div>
          <div className="space-y-2">
            <Label
              htmlFor="fromAddress"
              className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60"
            >
              From Address
            </Label>
            <Input
              id="fromAddress"
              name="fromAddress"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="Longhorn Sim Racing <noreply@notify.longhornsimracing.org>"
              className="rounded-none bg-white/5 border-white/10 text-white"
            />
            <p className="text-xs text-white/40">
              Format: Display Name &lt;email@domain.com&gt;
            </p>
          </div>
        </div>
      </div>

      {/* Environment Info */}
      <div className="border border-white/10 bg-white/[0.02] p-6">
        <h3 className="text-lg font-bold text-white mb-4">Environment</h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-white/60">Email Provider</span>
            <span className="text-white font-mono">Resend</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/60">API Key Configured</span>
            <span
              className={`font-mono ${resendKeyConfigured ? "text-green-500" : "text-red-500"}`}
            >
              {resendKeyConfigured ? "Yes" : "No"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/60">Domain</span>
            <span className="text-white font-mono">notify.longhornsimracing.org</span>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <Button
        type="submit"
        disabled={isPending}
        className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <Save className="h-4 w-4 mr-2" />
        )}
        Save Settings
      </Button>
    </form>
  );
}
