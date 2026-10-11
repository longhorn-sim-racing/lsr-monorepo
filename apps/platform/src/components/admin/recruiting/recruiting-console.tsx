"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, Download, Mail, Search, Settings2 } from "lucide-react";
import { toast } from "sonner";
import type { TrackStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { bulkDecideAction } from "@/app/admin/recruiting/actions";
import { OFFICER_SETTABLE, STATUSES_WITH_EMAIL, TRACK_STATUS_LABEL, TRACK_STATUS_ORDER, formatCentral } from "@/lib/recruiting/labels";
import type { CycleWindow } from "@/lib/recruiting/cycle";
import type { BulkDecisionResult } from "@/server/services/recruiting-email.service";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";

type Team = { key: string; label: string; interviewRequired: boolean };
export type ConsoleRow = {
  id: string;
  track: string;
  status: TrackStatus;
  applicationId: string;
  userId: string;
  name: string | null;
  email: string | null;
  gradYear: number | null;
  major: string | null;
  submittedAt: string | null;
  autoSubmitted: boolean;
  reviewCount: number;
  averageScore: number | null;
};
type Filters = { team?: string; status?: TrackStatus; q?: string; auto: boolean };

const WINDOW_LABEL: Record<CycleWindow, string> = { upcoming: "Not open yet", open: "Open for applications", closed: "Closed" };

export function RecruitingConsole({
  viewerId,
  cycles,
  cycle,
  teams,
  counts,
  rows,
  total,
  page,
  pageSize,
  filters,
  attentionCount,
}: {
  viewerId: string;
  cycles: Array<{ id: string; slug: string; name: string; isActive: boolean }>;
  cycle: { id: string; slug: string; name: string; isActive: boolean; window: CycleWindow; opensAt: string; closesAt: string; drafts: number };
  teams: Team[];
  counts: Array<{ track: string; status: TrackStatus; count: number }>;
  rows: ConsoleRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: Filters;
  attentionCount: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<TrackStatus | "">("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const teamByKey = useMemo(() => new Map(teams.map((t) => [t.key, t])), [teams]);

  /** A link to this page with some filters changed (paging resets). */
  function hrefFor(patch: Partial<Filters> & { cycle?: string; page?: number }, base = "/admin/recruiting") {
    const f = { ...filters, ...patch };
    const params = new URLSearchParams();
    params.set("cycle", patch.cycle ?? cycle.slug);
    if (f.team) params.set("team", f.team);
    if (f.status) params.set("status", f.status);
    if (f.q) params.set("q", f.q);
    if (f.auto) params.set("auto", "1");
    if (patch.page && patch.page > 1) params.set("page", String(patch.page));
    return `${base}?${params.toString()}`;
  }

  // Counts for the status chips follow the team filter
  const statusCounts = useMemo(() => {
    const out = new Map<TrackStatus, number>();
    for (const c of counts) if (!filters.team || c.track === filters.team) out.set(c.status, (out.get(c.status) ?? 0) + c.count);
    return out;
  }, [counts, filters.team]);
  const everything = TRACK_STATUS_ORDER.reduce((n, s) => n + (statusCounts.get(s) ?? 0), 0);

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const interviewPossible = selectedRows.every((r) => teamByKey.get(r.track)?.interviewRequired);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const csvHref = hrefFor({}, "/admin/recruiting/export");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex min-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 font-mono text-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-white/5 p-3">
        <div className="flex items-center gap-2 rounded border border-white/10 bg-black/50 px-3 py-1.5">
          <ClipboardList size={14} className="text-lsr-orange" />
          <span className="font-bold uppercase tracking-wider text-white/80">Recruiting</span>
        </div>

        <select
          aria-label="Round"
          value={cycle.slug}
          onChange={(e) => router.push(hrefFor({ cycle: e.target.value, team: undefined, status: undefined, q: undefined, auto: false }))}
          className="rounded border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white focus:border-lsr-orange focus:outline-none"
        >
          {cycles.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.name}
              {c.isActive ? " (active)" : ""}
            </option>
          ))}
        </select>

        <select
          aria-label="Team"
          value={filters.team ?? ""}
          onChange={(e) => router.push(hrefFor({ team: e.target.value || undefined }))}
          className="rounded border border-white/10 bg-black/50 px-3 py-1.5 text-xs text-white focus:border-lsr-orange focus:outline-none"
        >
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>

        <form action="/admin/recruiting" method="get" className="relative min-w-48 max-w-md flex-1">
          <input type="hidden" name="cycle" value={cycle.slug} />
          {filters.team && <input type="hidden" name="team" value={filters.team} />}
          {filters.status && <input type="hidden" name="status" value={filters.status} />}
          {filters.auto && <input type="hidden" name="auto" value="1" />}
          <Search size={14} className="absolute left-3 top-2 text-white/40" />
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            aria-label="Search by name or email"
            placeholder="Search name or email..."
            className="w-full rounded border border-white/10 bg-black/50 py-1.5 pl-9 pr-3 text-xs text-white focus:border-lsr-orange focus:outline-none"
          />
        </form>

        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 border-white/10 text-xs uppercase tracking-wider">
            <Link href={`/admin/recruiting/emails?cycle=${cycle.slug}`}>
              <Mail size={14} className="mr-1.5" /> Emails
              {attentionCount > 0 && <span className="ml-1.5 rounded bg-red-500/80 px-1.5 text-[10px] font-bold text-white">{attentionCount}</span>}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-8 border-white/10 text-xs uppercase tracking-wider">
            <Link href="/admin/recruiting/cycles"><Settings2 size={14} className="mr-1.5" /> Rounds</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-8 border-white/10 text-xs uppercase tracking-wider">
            {/* A plain link: it is a file download, not a page */}
            <a href={csvHref}><Download size={14} className="mr-1.5" /> CSV</a>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3 text-[11px]">
        <Chip href={hrefFor({ status: undefined })} active={!filters.status}>All {everything}</Chip>
        {TRACK_STATUS_ORDER.map((s) => (
          <Chip key={s} href={hrefFor({ status: s })} active={filters.status === s}>
            {TRACK_STATUS_LABEL[s]} {statusCounts.get(s) ?? 0}
          </Chip>
        ))}
        <Chip href={hrefFor({ auto: !filters.auto })} active={filters.auto}>Submitted automatically</Chip>
        <span className="ml-auto text-white/40">
          {cycle.name}: {WINDOW_LABEL[cycle.window]}, closes {formatCentral(cycle.closesAt)}
          {cycle.drafts > 0 && ` · ${cycle.drafts} unsubmitted draft${cycle.drafts === 1 ? "" : "s"}`}
        </span>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-lsr-orange/30 bg-lsr-orange/10 p-3 text-xs">
          <span className="font-bold text-lsr-orange">{selected.size} selected</span>
          <select
            aria-label="Set status for the selected"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value as TrackStatus | "")}
            className="rounded border border-white/10 bg-black/50 px-2 py-1.5 text-xs text-white focus:border-lsr-orange focus:outline-none"
          >
            <option value="">Set status to...</option>
            {OFFICER_SETTABLE.map((s) => (
              <option key={s} value={s} disabled={s === "INTERVIEW" && !interviewPossible}>
                {TRACK_STATUS_LABEL[s]}
                {s === "INTERVIEW" && !interviewPossible ? " (a selected team has no interviews)" : ""}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={!bulkStatus} onClick={() => setBulkOpen(true)} className="h-8 bg-lsr-orange text-xs uppercase tracking-wider text-white hover:bg-white hover:text-lsr-charcoal">
            Review and apply
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="h-8 text-xs uppercase tracking-wider text-white/60">Clear</Button>
        </div>
      )}

      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-white/5 text-[10px] uppercase tracking-wider text-white/40">
            <tr>
              <th className="w-8 px-3 py-2">
                <Checkbox
                  aria-label="Select everyone on this page"
                  checked={allOnPage}
                  onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              <th className="px-3 py-2">Applicant</th>
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Year / major</th>
              <th className="px-3 py-2">Reviews</th>
              <th className="px-3 py-2">Submitted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r) => (
              <tr key={r.id} className={cn("align-top hover:bg-white/[0.03]", selected.has(r.id) && "bg-lsr-orange/5")}>
                <td className="px-3 py-2">
                  <Checkbox aria-label={`Select ${r.name ?? "applicant"}`} checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                </td>
                <td className="px-3 py-2">
                  <Link href={`/admin/recruiting/${r.applicationId}`} className="font-bold text-white hover:text-lsr-orange">
                    {r.name || "Unnamed applicant"}
                  </Link>
                  {r.userId === viewerId && <span className="ml-2 rounded border border-amber-500/30 px-1.5 text-[10px] uppercase text-amber-300">you</span>}
                  <div className="text-white/40">{r.email}</div>
                </td>
                <td className="px-3 py-2 text-white/80">{teamByKey.get(r.track)?.label ?? r.track}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2 text-white/60">
                  {r.gradYear ?? "—"}
                  <div className="text-white/40">{r.major ?? ""}</div>
                </td>
                <td className="px-3 py-2 text-white/60">
                  {r.reviewCount === 0 ? <span className="text-white/25">none</span> : `${r.reviewCount}${r.averageScore !== null ? ` · avg ${r.averageScore.toFixed(1)}` : ""}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-white/50">
                  {formatCentral(r.submittedAt, "MMM d, h:mm a")}
                  {r.autoSubmitted && <div className="text-amber-300/80">automatic</div>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center uppercase tracking-widest text-white/30">
                  {everything === 0 ? "No submitted applications yet" : "Nothing matches these filters"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 border-t border-white/10 p-3 text-xs text-white/50">
        <span>{total} team application{total === 1 ? "" : "s"}</span>
        {pages > 1 && (
          <span className="ml-auto flex items-center gap-2">
            {page > 1 && <Link className="hover:text-white" href={hrefFor({ page: page - 1 })}>Previous</Link>}
            <span>Page {page} of {pages}</span>
            {page < pages && <Link className="hover:text-white" href={hrefFor({ page: page + 1 })}>Next</Link>}
          </span>
        )}
      </div>

      {bulkOpen && bulkStatus && (
        <BulkDialog
          status={bulkStatus}
          rows={selectedRows}
          teamByKey={teamByKey}
          onClose={(changed) => {
            setBulkOpen(false);
            if (changed) {
              setSelected(new Set());
              setBulkStatus("");
              router.refresh();
            }
          }}
        />
      )}
    </div>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn("rounded border px-3 py-1 uppercase tracking-wider transition-colors", active ? "border-lsr-orange bg-lsr-orange/10 text-lsr-orange" : "border-white/10 text-white/50 hover:text-white")}
    >
      {children}
    </Link>
  );
}

/** Confirms a bulk change: who, what, how many emails, and (if the daily limit blocks it) the way around. */
function BulkDialog({
  status,
  rows,
  teamByKey,
  onClose,
}: {
  status: TrackStatus;
  rows: ConsoleRow[];
  teamByKey: Map<string, Team>;
  onClose: (changed: boolean) => void;
}) {
  const canEmail = STATUSES_WITH_EMAIL.includes(status);
  const [sendEmail, setSendEmail] = useState(canEmail);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkDecisionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const label = TRACK_STATUS_LABEL[status];

  function apply() {
    setError(null);
    startTransition(async () => {
      const res = await bulkDecideAction(rows.map((r) => r.id), status, { sendEmail, ignoreLimit });
      if (!res.ok) {
        setError(res.error);
        setLimitHit(res.code === "EMAIL_LIMIT");
        return;
      }
      const d = res.data;
      const parts = [`${d.decided} of ${d.total} marked ${label}`];
      if (sendEmail) parts.push(`${d.emailsSent} email${d.emailsSent === 1 ? "" : "s"} sent${d.emailsFailed ? `, ${d.emailsFailed} failed (resend them from the Emails page)` : ""}`);
      if (d.failures.length === 0) {
        toast.success(parts.join(". ") + ".");
        onClose(true);
      } else {
        toast.warning(parts.join(". ") + `. ${d.failures.length} could not be changed.`);
        setResult(d);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose(result !== null)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto border-white/10 bg-lsr-charcoal text-white">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-black uppercase italic">Mark {rows.length} as {label}</DialogTitle>
          <DialogDescription className="text-white/60">Each is decided separately, for the team shown.</DialogDescription>
        </DialogHeader>

        <ul className="max-h-40 space-y-1 overflow-y-auto rounded border border-white/10 bg-black/40 p-2 text-xs">
          {rows.map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <span className="truncate text-white/80">{r.name ?? "Unnamed applicant"}</span>
              <span className="shrink-0 text-white/40">{teamByKey.get(r.track)?.label ?? r.track}</span>
            </li>
          ))}
        </ul>

        {result ? (
          <div className="space-y-2 text-xs">
            <p className="text-white/80">{result.decided} of {result.total} were changed. These were not:</p>
            <ul className="space-y-1 text-red-200">
              {result.failures.map((f) => {
                const row = rows.find((r) => r.id === f.applicationTrackId);
                return <li key={f.applicationTrackId}>{row?.name ?? "Applicant"}: {f.error}</li>;
              })}
            </ul>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            {canEmail ? (
              <label className="flex items-start gap-2 text-white/80">
                <Checkbox checked={sendEmail} onCheckedChange={(v) => setSendEmail(v === true)} className="mt-0.5" />
                <span>
                  Email the applicants. <strong>{rows.length} email{rows.length === 1 ? "" : "s"}</strong> would go out using the default message for this status, with each person&apos;s name and team filled in. Emails can&apos;t be unsent. To write a custom message, open the application instead.
                </span>
              </label>
            ) : (
              <p className="text-white/50">No email is sent for this status.</p>
            )}
            {limitHit && (
              <label className="flex items-start gap-2 text-amber-200">
                <Checkbox checked={ignoreLimit} onCheckedChange={(v) => setIgnoreLimit(v === true)} className="mt-0.5" />
                <span>Send anyway. Emails over today&apos;s limit will fail and show up on the Emails page to resend later.</span>
              </label>
            )}
            {error && <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-200">{error}</p>}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={() => onClose(result !== null)} className="text-white/60">
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button type="button" disabled={pending || (limitHit && !ignoreLimit)} onClick={apply} className="bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal">
              {pending ? "Working..." : sendEmail ? `Mark ${label} and email` : `Mark ${label}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
