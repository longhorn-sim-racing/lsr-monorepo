"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { TrackStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { decideAction, previewDecisionAction } from "@/app/admin/recruiting/actions";
import { STATUSES_WITH_EMAIL, TRACK_STATUS_LABEL } from "@/lib/recruiting/labels";

type Preview = { to: string; subject: string; body: string; html: string };

const fieldClass =
  "w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors";

/**
 * Set one team's status for one applicant, optionally emailing them. Shows the exact message
 * that will be sent (the default draft, already filled in for this person) and lets the officer
 * change it for this one person; the saved defaults are never changed from here.
 */
export function DecisionDialog({
  trackId,
  teamLabel,
  applicantName,
  status,
  onClose,
}: {
  trackId: string;
  teamLabel: string;
  applicantName: string;
  /** The status being set; null keeps the dialog closed */
  status: TrackStatus | null;
  /** `changed` is true after a successful save, so the page can refresh */
  onClose: (changed: boolean) => void;
}) {
  return (
    <Dialog open={status !== null} onOpenChange={(open) => !open && onClose(false)}>
      {status && (
        <DecisionForm key={`${trackId}:${status}`} trackId={trackId} teamLabel={teamLabel} applicantName={applicantName} status={status} onClose={onClose} />
      )}
    </Dialog>
  );
}

function DecisionForm({
  trackId,
  teamLabel,
  applicantName,
  status,
  onClose,
}: {
  trackId: string;
  teamLabel: string;
  applicantName: string;
  status: TrackStatus;
  onClose: (changed: boolean) => void;
}) {
  const hasEmail = STATUSES_WITH_EMAIL.includes(status);
  const label = TRACK_STATUS_LABEL[status];
  const [sendEmail, setSendEmail] = useState(hasEmail);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [original, setOriginal] = useState<{ subject: string; body: string } | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Fetches the message. Without an edit it resets the text to the default; with one it only refreshes the picture. */
  const load = useCallback(
    async (edit?: { subject: string; body: string }) => {
      setLoading(true);
      setPreviewError(null);
      const res = await previewDecisionAction(trackId, status, edit);
      setLoading(false);
      if (!res.ok) return setPreviewError(res.fieldErrors?.body ? `${res.error} (${res.fieldErrors.body})` : res.error);
      if (!res.data) return;
      setPreview(res.data);
      if (!edit) {
        setSubject(res.data.subject);
        setBody(res.data.body);
        setOriginal({ subject: res.data.subject, body: res.data.body });
      }
    },
    [trackId, status],
  );

  useEffect(() => {
    if (hasEmail) void load();
  }, [hasEmail, load]);

  const edited = Boolean(original && (subject !== original.subject || body !== original.body));
  const blocked = sendEmail && (loading || previewError !== null || !preview);

  function save() {
    setFormError(null);
    startTransition(async () => {
      const res = await decideAction(trackId, status, { sendEmail, override: sendEmail && edited ? { subject, body } : undefined });
      if (!res.ok) return setFormError(res.fieldErrors?.body ? `${res.error} (${res.fieldErrors.body})` : res.error);
      const delivery = res.data.delivery;
      if (!sendEmail) toast.success(`${teamLabel}: marked ${label}.`);
      else if (delivery?.status === "SENT") toast.success(`${teamLabel}: marked ${label}. Email sent to ${preview?.to ?? "the applicant"}.`);
      else toast.warning(`${teamLabel}: marked ${label}, but the email did not send (${delivery?.error ?? "unknown reason"}). Resend it from the Emails page.`);
      onClose(true);
    });
  }

  return (
    <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto border-white/10 bg-lsr-charcoal text-white">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-black uppercase italic">
          {teamLabel}: {label}
        </DialogTitle>
        <DialogDescription className="text-white/60">for {applicantName}</DialogDescription>
      </DialogHeader>

      {hasEmail ? (
        <div className="space-y-4 text-sm">
          <label className="flex items-center gap-2 text-white/80">
            <Checkbox checked={sendEmail} onCheckedChange={(v) => setSendEmail(v === true)} />
            Email {applicantName}
            {preview && <span className="text-white/40">({preview.to})</span>}
          </label>

          {sendEmail && (
            <>
              {loading && !preview && <p className="text-xs text-white/50">Preparing the message...</p>}
              {previewError && (
                <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  {previewError}
                </p>
              )}
              {preview && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="decision-subject" className="mb-1 block text-[11px] uppercase tracking-wider text-white/40">Subject</label>
                    <input id="decision-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={fieldClass} />
                  </div>
                  <div>
                    <label htmlFor="decision-body" className="mb-1 block text-[11px] uppercase tracking-wider text-white/40">Message</label>
                    <textarea id="decision-body" value={body} onChange={(e) => setBody(e.target.value)} rows={11} maxLength={5000} className={`${fieldClass} font-sans leading-relaxed`} />
                    <p className="mt-1 text-[11px] text-white/40">
                      Changes apply to this email only. Blank lines start a new paragraph.
                      {status === "INTERVIEW" && " The team's booking link is included automatically when one is set on the Rounds page; otherwise the message asks them to reply."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={loading} className="h-7 border-white/10 text-[11px] uppercase tracking-wider" onClick={() => void load({ subject, body })}>
                      {loading ? "Updating..." : "Update preview"}
                    </Button>
                    {edited && (
                      <Button type="button" variant="ghost" size="sm" disabled={loading} className="h-7 text-[11px] uppercase tracking-wider text-white/60" onClick={() => void load()}>
                        Reset to default
                      </Button>
                    )}
                    {edited && <span className="text-[11px] text-amber-300">Edited for this email</span>}
                  </div>
                  {/* The HTML is built from escaped text on the server; the empty sandbox attribute also blocks scripts and links */}
                  <iframe title="How the email will look" sandbox="" srcDoc={preview.html} className="h-72 w-full rounded border border-white/10 bg-white" />
                </div>
              )}
            </>
          )}
          {!sendEmail && <p className="text-xs text-white/50">The status will change without telling the applicant. They can still see it on their status page.</p>}
        </div>
      ) : (
        <p className="text-sm text-white/60">No email is sent for this status. The applicant sees it on their status page.</p>
      )}

      {formError && (
        <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {formError}
        </p>
      )}

      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={() => onClose(false)} disabled={pending} className="text-white/60">
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={pending || blocked} className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal">
          {pending ? "Saving..." : sendEmail ? "Save and send email" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
