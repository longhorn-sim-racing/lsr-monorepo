"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { TrackStatus } from "@prisma/client";
import { Button, CheckboxField, Dialog, Field, Input, Notice, Textarea } from "@/components/admin/kit";
import { decideAction, previewDecisionAction } from "@/app/admin/recruiting/actions";
import { STATUSES_WITH_EMAIL, TRACK_STATUS_LABEL } from "@/lib/recruiting/labels";

type Preview = { to: string; subject: string; body: string; html: string };

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
  if (!status) return null;
  return <DecisionForm key={`${trackId}:${status}`} trackId={trackId} teamLabel={teamLabel} applicantName={applicantName} status={status} onClose={onClose} />;
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
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose(false)}
      size="lg"
      title={`${teamLabel}: ${label}`}
      description={`for ${applicantName}`}
      footer={
        <>
          <Button disabled={pending} onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="primary" pending={pending} disabled={blocked} onClick={save}>
            {sendEmail ? "Save and send email" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {hasEmail ? (
          <>
            <CheckboxField
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              label={`Email ${applicantName}${preview ? ` (${preview.to})` : ""}`}
            />

            {sendEmail && (
              <>
                {loading && !preview && <p className="text-xs text-admin-subtle">Preparing the message...</p>}
                {previewError && <Notice tone="danger">{previewError}</Notice>}
                {preview && (
                  <div className="space-y-3">
                    <Field label="Subject" htmlFor="decision-subject">
                      <Input id="decision-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
                    </Field>
                    <Field
                      label="Message"
                      htmlFor="decision-body"
                      hint={
                        <>
                          Changes apply to this email only. Blank lines start a new paragraph.
                          {status === "INTERVIEW" && " The team's booking link is included automatically when one is set on the Rounds page; otherwise the message asks them to reply."}
                        </>
                      }
                    >
                      <Textarea id="decision-body" value={body} onChange={(e) => setBody(e.target.value)} rows={11} maxLength={5000} className="leading-relaxed" />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" disabled={loading} onClick={() => void load({ subject, body })}>
                        {loading ? "Updating..." : "Update preview"}
                      </Button>
                      {edited && (
                        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
                          Reset to default
                        </Button>
                      )}
                      {edited && <span className="text-xs font-medium text-tone-warning-foreground">Edited for this email</span>}
                    </div>
                    {/* The HTML is built from escaped text on the server; the empty sandbox attribute also blocks scripts and links.
                        The frame stays white in both themes because that is how the email looks in an inbox. */}
                    <iframe title="How the email will look" sandbox="" srcDoc={preview.html} className="h-72 w-full rounded-md border bg-white" />
                  </div>
                )}
              </>
            )}
            {!sendEmail && <p className="text-xs text-admin-subtle">The status will change without telling the applicant. They can still see it on their status page.</p>}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">No email is sent for this status. The applicant sees it on their status page.</p>
        )}

        {formError && <Notice tone="danger">{formError}</Notice>}
      </div>
    </Dialog>
  );
}
