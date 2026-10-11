"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { TrackStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { addReviewAction, resendEmailAction } from "@/app/admin/recruiting/actions";
import { EMAIL_STATUS_BADGE, EMAIL_TEMPLATE_LABEL, OFFICER_SETTABLE, TRACK_STATUS_LABEL, formatCentral } from "@/lib/recruiting/labels";
import { cn } from "@/lib/utils";
import { DecisionDialog } from "./decision-dialog";
import { StatusBadge } from "./status-badge";

export type PanelReview = { id: string; score: number | null; notes: string | null; createdAt: string; reviewer: string | null };
export type PanelEmail = { id: string; template: string; subject: string; status: string; error: string | null; sentAt: string | null; createdAt: string };

const fieldClass =
  "w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors";

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
    <section className="rounded-lg border border-white/10 bg-black/40">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-white/5 px-4 py-3">
        <h2 className="font-display text-lg font-black uppercase italic">{teamLabel}</h2>
        <StatusBadge status={status} />
        {decidedAt && (
          <span className="text-[11px] text-white/40">
            {decidedBy ? `by ${decidedBy}, ` : ""}
            {formatCentral(decidedAt)}
          </span>
        )}
        {!interviewRequired && <span className="rounded border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/40">No interview</span>}
      </header>

      <div className="space-y-6 p-4">
        {isOwn ? (
          <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            This is your own application. You can read it, but you can&apos;t review or decide it.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-white/40">Mark as</span>
            {choices.map((s) => (
              <Button
                key={s}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setTarget(s)}
                className={cn("h-8 border-white/10 text-xs uppercase tracking-wider", s === "ACCEPTED" && "text-green-400", s === "REJECTED" && "text-red-300", s === "INTERVIEW" && "text-sky-300")}
              >
                {TRACK_STATUS_LABEL[s]}
              </Button>
            ))}
          </div>
        )}

        <div>
          <h3 className="mb-3 text-[11px] uppercase tracking-wider text-lsr-orange">{teamLabel} answers</h3>
          {children}
        </div>

        <ReviewsSection trackId={trackId} reviews={reviews} canAdd={!isOwn} />
        <EmailsSection emails={emails} canResend={!isOwn} />
      </div>

      <DecisionDialog
        trackId={trackId}
        teamLabel={teamLabel}
        applicantName={applicantName}
        status={target}
        onClose={(changed) => {
          setTarget(null);
          if (changed) router.refresh();
        }}
      />
    </section>
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
      <h3 className="mb-3 text-[11px] uppercase tracking-wider text-lsr-orange">Reviews</h3>
      {reviews.length === 0 ? (
        <p className="text-xs text-white/40">No reviews yet.</p>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-white/50">
                <span className="font-bold text-white/80">{r.reviewer ?? "Former officer"}</span>
                {r.score !== null && <span className="rounded border border-lsr-orange/40 bg-lsr-orange/10 px-1.5 text-lsr-orange">{r.score}/5</span>}
                <span>{formatCentral(r.createdAt)}</span>
              </div>
              {r.notes && <p className="mt-1 whitespace-pre-wrap text-white/80">{r.notes}</p>}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <form onSubmit={add} className="mt-3 space-y-2">
          <div className="flex gap-2">
            <select aria-label="Score" value={score} onChange={(e) => setScore(e.target.value)} className="rounded border border-white/10 bg-black/50 px-2 py-2 text-xs text-white focus:border-lsr-orange focus:outline-none">
              <option value="">No score</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} / 5</option>
              ))}
            </select>
            <textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Notes for the other officers" className={fieldClass} />
          </div>
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
          <Button type="submit" size="sm" disabled={pending || (!score && !notes.trim())} className="h-8 bg-white/10 text-xs uppercase tracking-wider hover:bg-white/20">
            {pending ? "Adding..." : "Add review"}
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
      <h3 className="mb-3 text-[11px] uppercase tracking-wider text-lsr-orange">{title}</h3>
      {emails.length === 0 ? (
        <p className="text-xs text-white/40">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {emails.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-white/80">{EMAIL_TEMPLATE_LABEL[m.template] ?? m.template}</span>
                  <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider", EMAIL_STATUS_BADGE[m.status])}>{m.status.toLowerCase()}</span>
                  <span className="text-white/40">{formatCentral(m.sentAt ?? m.createdAt)}</span>
                </div>
                <div className="mt-1 truncate text-white/60">{m.subject}</div>
                {m.error && <div className="mt-1 text-red-300/80">{m.error}</div>}
              </div>
              {canResend && m.status === "FAILED" && (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => resend(m.id)} className="h-7 border-white/10 text-[11px] uppercase tracking-wider">
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
