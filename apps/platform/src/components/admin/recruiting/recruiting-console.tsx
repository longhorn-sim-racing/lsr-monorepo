"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Mail, Settings2 } from "lucide-react";
import { toast } from "sonner";
import type { TrackStatus } from "@prisma/client";
import {
  Badge,
  Button,
  CheckboxField,
  Dialog,
  EmptyState,
  Input,
  Notice,
  Pager,
  Panel,
  Segmented,
  Select,
  TD,
  TH,
  THead,
  TR,
  Table,
  Toolbar,
  type SegmentOption,
} from "@/components/admin/kit";
import { bulkDecideAction } from "@/app/admin/recruiting/actions";
import { OFFICER_SETTABLE, STATUSES_WITH_EMAIL, TRACK_STATUS_LABEL, TRACK_STATUS_ORDER, formatCentral } from "@/lib/recruiting/labels";
import type { CycleWindow } from "@/lib/recruiting/cycle";
import type { BulkDecisionResult } from "@/server/services/recruiting-email.service";
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
  replyToMissing,
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
  /** Production without RECRUITING_REPLY_TO: replies to the emails would go nowhere */
  replyToMissing: boolean;
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

  // Counts for the status filter follow the team filter
  const statusCounts = useMemo(() => {
    const out = new Map<TrackStatus, number>();
    for (const c of counts) if (!filters.team || c.track === filters.team) out.set(c.status, (out.get(c.status) ?? 0) + c.count);
    return out;
  }, [counts, filters.team]);
  const everything = TRACK_STATUS_ORDER.reduce((n, s) => n + (statusCounts.get(s) ?? 0), 0);

  const statusOptions: SegmentOption<TrackStatus | "ALL">[] = [
    { value: "ALL", label: "All", count: everything },
    ...TRACK_STATUS_ORDER.map((s) => ({ value: s, label: TRACK_STATUS_LABEL[s], count: statusCounts.get(s) ?? 0 })),
  ];

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
    <>
      <Toolbar
        actions={
          <>
            <Button asChild>
              <Link href={`/admin/recruiting/emails?cycle=${cycle.slug}`}>
                <Mail /> Emails
                {attentionCount > 0 && <Badge tone="danger">{attentionCount}</Badge>}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/admin/recruiting/cycles">
                <Settings2 /> Rounds
              </Link>
            </Button>
            <Button asChild>
              {/* A plain link: it is a file download, not a page */}
              <a href={csvHref}>
                <Download /> CSV
              </a>
            </Button>
          </>
        }
      >
        <Select
          aria-label="Round"
          className="w-auto"
          value={cycle.slug}
          onChange={(e) => router.push(hrefFor({ cycle: e.target.value, team: undefined, status: undefined, q: undefined, auto: false }))}
        >
          {cycles.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.name}
              {c.isActive ? " (active)" : ""}
            </option>
          ))}
        </Select>

        <Select aria-label="Team" className="w-auto" value={filters.team ?? ""} onChange={(e) => router.push(hrefFor({ team: e.target.value || undefined }))}>
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </Select>

        <form action="/admin/recruiting" method="get" className="min-w-48 max-w-sm flex-1">
          <input type="hidden" name="cycle" value={cycle.slug} />
          {filters.team && <input type="hidden" name="team" value={filters.team} />}
          {filters.status && <input type="hidden" name="status" value={filters.status} />}
          {filters.auto && <input type="hidden" name="auto" value="1" />}
          <Input name="q" type="search" defaultValue={filters.q ?? ""} aria-label="Search by name or email" placeholder="Search name or email" />
        </form>
      </Toolbar>

      <Toolbar>
        <Segmented
          label="Status"
          options={statusOptions}
          value={filters.status ?? "ALL"}
          onChange={(v) => router.push(hrefFor({ status: v === "ALL" ? undefined : v }))}
        />
        <Button aria-pressed={filters.auto} variant={filters.auto ? "primary" : "secondary"} onClick={() => router.push(hrefFor({ auto: !filters.auto }))}>
          Submitted automatically
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {cycle.name}: {WINDOW_LABEL[cycle.window]}, closes {formatCentral(cycle.closesAt)}
          {cycle.drafts > 0 && ` · ${cycle.drafts} unsubmitted draft${cycle.drafts === 1 ? "" : "s"}`}
        </span>
      </Toolbar>

      {selectedRows.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-lg border bg-admin-selected px-3.5 py-2.5 text-[13px]">
          <span className="font-semibold">{selectedRows.length} selected</span>
          <Select
            aria-label="Set status for the selected"
            className="w-auto"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value as TrackStatus | "")}
          >
            <option value="">Set status to...</option>
            {OFFICER_SETTABLE.map((s) => (
              <option key={s} value={s} disabled={s === "INTERVIEW" && !interviewPossible}>
                {TRACK_STATUS_LABEL[s]}
                {s === "INTERVIEW" && !interviewPossible ? " (a selected team has no interviews)" : ""}
              </option>
            ))}
          </Select>
          <Button variant="primary" disabled={!bulkStatus} onClick={() => setBulkOpen(true)}>
            Review and apply
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <Panel>
          <EmptyState
            title={everything === 0 ? "No submitted applications yet" : "Nothing matches these filters"}
            description={everything === 0 ? "Applications appear here as soon as applicants submit. Drafts are never shown." : "Try a different team or status, or clear the search."}
          />
        </Panel>
      ) : (
        <Table minWidth={760}>
          <THead>
            <TH className="w-8">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                aria-label="Select everyone on this page"
                checked={allOnPage}
                onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
              />
            </TH>
            <TH>Applicant</TH>
            <TH>Team</TH>
            <TH>Status</TH>
            <TH>Year / major</TH>
            <TH>Reviews</TH>
            <TH>Submitted</TH>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id} selected={selected.has(r.id)} className="align-top">
                <TD>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    aria-label={`Select ${r.name ?? "applicant"}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </TD>
                <TD>
                  <Link href={`/admin/recruiting/${r.applicationId}`} className="font-semibold hover:text-primary hover:underline">
                    {r.name || "Unnamed applicant"}
                  </Link>
                  {r.userId === viewerId && (
                    <Badge tone="warning" className="ml-2">
                      you
                    </Badge>
                  )}
                  <div className="text-xs text-admin-subtle">{r.email}</div>
                </TD>
                <TD>{teamByKey.get(r.track)?.label ?? r.track}</TD>
                <TD>
                  <StatusBadge status={r.status} />
                </TD>
                <TD>
                  {r.gradYear ?? "—"}
                  <div className="text-xs text-admin-subtle">{r.major ?? ""}</div>
                </TD>
                <TD className="text-muted-foreground">
                  {r.reviewCount === 0 ? <span className="text-admin-subtle">none</span> : `${r.reviewCount}${r.averageScore !== null ? ` · avg ${r.averageScore.toFixed(1)}` : ""}`}
                </TD>
                <TD className="whitespace-nowrap text-muted-foreground">
                  {formatCentral(r.submittedAt, "MMM d, h:mm a")}
                  {r.autoSubmitted && <div className="text-xs text-tone-warning-foreground">automatic</div>}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}

      <Pager
        page={page}
        pageCount={pages}
        hrefFor={(p) => hrefFor({ page: p })}
        summary={`${total} team application${total === 1 ? "" : "s"}${pages > 1 ? ` · page ${page} of ${pages}` : ""}`}
      />

      {bulkOpen && bulkStatus && (
        <BulkDialog
          status={bulkStatus}
          rows={selectedRows}
          teamByKey={teamByKey}
          replyToMissing={replyToMissing}
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
    </>
  );
}

/** Confirms a bulk change: who, what, how many emails, and (if the daily limit blocks it) the way around. */
function BulkDialog({
  status,
  rows,
  teamByKey,
  replyToMissing,
  onClose,
}: {
  status: TrackStatus;
  rows: ConsoleRow[];
  teamByKey: Map<string, Team>;
  replyToMissing: boolean;
  onClose: (changed: boolean) => void;
}) {
  const canEmail = STATUSES_WITH_EMAIL.includes(status);
  const [sendEmail, setSendEmail] = useState(canEmail);
  const [ignoreLimit, setIgnoreLimit] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  // Rows already at the target status are refused anyway, so they aren't "changed" and need no warning
  const reversing = rows.filter((r) => (r.status === "ACCEPTED" || r.status === "REJECTED") && r.status !== status);
  const [confirmedReversal, setConfirmedReversal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkDecisionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const label = TRACK_STATUS_LABEL[status];

  function apply() {
    setError(null);
    startTransition(async () => {
      const res = await bulkDecideAction(rows.map((r) => r.id), status, {
        sendEmail,
        ignoreLimit,
        // What each officer saw, so a row a colleague changed in the meantime is refused, not overwritten
        expectedStatuses: Object.fromEntries(rows.map((r) => [r.id, r.status])),
      });
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
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose(result !== null)}
      title={`Mark ${rows.length} as ${label}`}
      description="Each is decided separately, for the team shown."
      footer={
        <>
          <Button disabled={pending} onClick={() => onClose(result !== null)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              variant="primary"
              pending={pending}
              disabled={(limitHit && !ignoreLimit) || (reversing.length > 0 && !confirmedReversal)}
              onClick={apply}
            >
              {sendEmail ? `Mark ${label} and email` : `Mark ${label}`}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-admin-surface p-2 text-xs">
          {rows.map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <span className="truncate">{r.name ?? "Unnamed applicant"}</span>
              <span className="shrink-0 text-admin-subtle">{teamByKey.get(r.track)?.label ?? r.track}</span>
            </li>
          ))}
        </ul>

        {!result && reversing.length > 0 && (
          <Notice
            tone="warning"
            title={`${reversing.length} ${reversing.length === 1 ? "is" : "are"} already Accepted or Not moving forward`}
          >
            <p>Those applicants may already have been told. Changing them can send a second, different email.</p>
            <div className="mt-2">
              <CheckboxField checked={confirmedReversal} onChange={(e) => setConfirmedReversal(e.target.checked)} label="Yes, change them too" />
            </div>
          </Notice>
        )}

        {result ? (
          <Notice tone="warning" title={`${result.decided} of ${result.total} were changed. These were not:`}>
            <ul className="space-y-1">
              {result.failures.map((f) => {
                const row = rows.find((r) => r.id === f.applicationTrackId);
                return (
                  <li key={f.applicationTrackId}>
                    {row?.name ?? "Applicant"}: {f.error}
                  </li>
                );
              })}
            </ul>
          </Notice>
        ) : (
          <>
            {canEmail ? (
              <CheckboxField
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                label="Email the applicants"
                description={`${rows.length} email${rows.length === 1 ? "" : "s"} would go out using the default message for this status, with each person's name and team filled in. Emails can't be unsent. To write a custom message, open the application instead.`}
              />
            ) : (
              <p className="text-xs text-admin-subtle">No email is sent for this status.</p>
            )}
            {sendEmail && replyToMissing && (
              <Notice tone="warning">
                RECRUITING_REPLY_TO is not set, so replies to these emails go to the noreply address and nobody sees them. Ask a tech officer to set it before sending.
              </Notice>
            )}
            {limitHit && (
              <CheckboxField
                checked={ignoreLimit}
                onChange={(e) => setIgnoreLimit(e.target.checked)}
                label="Send anyway"
                description="Emails over today's limit will fail and show up on the Emails page to resend later."
              />
            )}
            {error && (
              <Notice tone="danger">{error}</Notice>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
