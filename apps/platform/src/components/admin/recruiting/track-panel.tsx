"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { TrackStatus } from "@prisma/client";
import { Badge, Button, Notice, Panel, PanelBody, PanelHeader, Select, Textarea } from "@/components/admin/kit";
import { addReviewAction, resendEmailAction } from "@/app/admin/recruiting/actions";
import { EMAIL_STATUS_TONE, EMAIL_TEMPLATE_LABEL, OFFICER_SETTABLE, TRACK_STATUS_LABEL, formatCentral } from "@/lib/recruiting/labels";
import { DecisionDialog } from "./decision-dialog";
import { StatusBadge } from "./status-badge";

export type PanelReview = { id: string; score: number | null; notes: string | null; createdAt: string; reviewer: string | null };
export type PanelEmail = { id: string; template: string; subject: string; status: string; error: string | null; sentAt: string | null; createdAt: string };

const sectionTitle = "mb-2.5 text-xs font-bold text-foreground";

/** Everything about one team's application: decision buttons, the team's answers (children), reviews, and email history. */
export function TrackPanel({
  trackId,
  teamLabel,
  interviewRequired,
  status,
  decidedAt,
  decidedBy,
  applicantName,
  isOwn,
  reviews,
  emails,
  children,
}: {
  trackId: string;
  teamLabel: string;
  interviewRequired: boolean;
  status: TrackStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  applicantName: string;
  /** The signed-in officer is this applicant: they can read it but not review or decide it */
  isOwn: boolean;
  reviews: PanelReview[];
  emails: PanelEmail[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<TrackStatus | null>(null);

  // Interview only exists for teams that run interviews
  const choices = OFFICER_SETTABLE.filter((s) => s !== status && (s !== "INTERVIEW" || interviewRequired));

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {teamLabel}
            <StatusBadge status={status} />
            {!interviewRequired && <Badge>No interview</Badge>}
          </span>
        }
        description={decidedAt ? `${decidedBy ? `Decided by ${decidedBy}, ` : "Decided "}${formatCentral(decidedAt)}` : undefined}
      />

      <PanelBody className="space-y-6">
        {isOwn ? (
          <Notice tone="warning">This is your own application. You can read it, but you can&apos;t review or decide it.</Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Mark as</span>
            {choices.map((s) => (
              <Button key={s} onClick={() => setTarget(s)}>
                {TRACK_STATUS_LABEL[s]}
              </Button>
            ))}
          </div>
        )}

        <div>
          <h3 className={sectionTitle}>{teamLabel} answers</h3>
          {children}
        </div>

        <ReviewsSection trackId={trackId} reviews={reviews} canAdd={!isOwn} />
        <EmailsSection emails={emails} canResend={!isOwn} />
      </PanelBody>

      <DecisionDialog
        trackId={trackId}
        teamLabel={teamLabel}
        applicantName={applicantName}
        currentStatus={status}
        status={target}
        onClose={(changed) => {
          setTarget(null);
          if (changed) router.refresh();
        }}
      />
    </Panel>
  );
}

function ReviewsSection({ trackId, reviews, canAdd }: { trackId: string; reviews: PanelReview[]; canAdd: boolean }) {
  const router = useRouter();
  const [score, setScore] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await addReviewAction(trackId, { score: score ? Number(score) : undefined, notes: notes.trim() || undefined });
      if (!res.ok) return setError(res.error);
      setScore("");
      setNotes("");
      toast.success("Review added.");
      router.refresh();
    });
  }

  return (
    <div>
      <h3 className={sectionTitle}>Reviews</h3>
      {reviews.length === 0 ? (
        <p className="text-xs text-admin-subtle">No reviews yet.</p>
      ) : (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-md border bg-admin-surface px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{r.reviewer ?? "Former officer"}</span>
                {r.score !== null && <Badge tone="accent">{r.score}/5</Badge>}
                <span>{formatCentral(r.createdAt)}</span>
              </div>
              {r.notes && <p className="mt-1 whitespace-pre-wrap">{r.notes}</p>}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <form onSubmit={add} className="mt-3 space-y-2">
          <div className="flex gap-2">
            <Select aria-label="Score" className="w-28 shrink-0" value={score} onChange={(e) => setScore(e.target.value)}>
              <option value="">No score</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} / 5
                </option>
              ))}
            </Select>
            <Textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Notes for the other officers" />
          </div>
          {error && (
            <p role="alert" className="text-xs font-medium text-tone-danger-foreground">
              {error}
            </p>
          )}
          <Button type="submit" pending={pending} disabled={!score && !notes.trim()}>
            Add review
          </Button>
        </form>
      )}
    </div>
  );
}

/** An applicant's emails with their outcome and a Resend button for failures. Also used for the application-level confirmation. */
export function EmailsSection({ emails, canResend, title = "Emails to the applicant", emptyText = "None sent for this team." }: { emails: PanelEmail[]; canResend: boolean; title?: string; emptyText?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function resend(id: string) {
    startTransition(async () => {
      const res = await resendEmailAction(id);
      if (!res.ok) return void toast.error(res.error);
      if (res.data.status === "SENT") toast.success("Email sent.");
      else toast.warning(`Still not sent: ${res.data.error ?? "unknown reason"}`);
      router.refresh();
    });
  }

  return (
    <div>
      <h3 className={sectionTitle}>{title}</h3>
      {emails.length === 0 ? (
        <p className="text-xs text-admin-subtle">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {emails.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 rounded-md border bg-admin-surface px-3 py-2 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{EMAIL_TEMPLATE_LABEL[m.template] ?? m.template}</span>
                  <Badge tone={EMAIL_STATUS_TONE[m.status] ?? "neutral"}>{m.status.toLowerCase()}</Badge>
                  <span className="text-xs text-admin-subtle">{formatCentral(m.sentAt ?? m.createdAt)}</span>
                </div>
                <div className="mt-1 truncate text-muted-foreground">{m.subject}</div>
                {m.error && <div className="mt-1 text-xs text-tone-danger-foreground">{m.error}</div>}
              </div>
              {canResend && m.status === "FAILED" && (
                <Button size="sm" disabled={pending} onClick={() => resend(m.id)}>
                  Resend
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
