import { formatInTimeZone } from "date-fns-tz";
import type { TrackStatus } from "@prisma/client";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { genericQuestions, getTrack, questionsForTrack, tracks } from "@/schemas/recruiting.schema";
import { formatAnswer } from "@/lib/recruiting/answers";
import { TRACK_STATUS_LABEL } from "@/lib/recruiting/labels";
import { toCsv, uniqueHeaders } from "@/lib/recruiting/csv";

/** One submitted team application, flattened for the spreadsheet. */
export type ExportRow = {
  applicationId: string;
  /** The applicant's ACCOUNT email (the copy on the application can differ) */
  email: string;
  fullName: string | null;
  eid: string | null;
  gradYear: number | null;
  major: string | null;
  track: string;
  status: TrackStatus;
  submittedAt: Date | null;
  autoSubmitted: boolean;
  reviewCount: number;
  averageScore: number | null;
  resumeUrl: string | null;
  genericAnswers: unknown;
  trackAnswers: unknown;
};

const stamp = (d: Date | null) => (d ? formatInTimeZone(d, DEFAULT_TIMEZONE, "yyyy-MM-dd HH:mm") : "");
const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * One row per applicant per team (someone who applied to three teams appears three times, with
 * their general answers repeated so every row stands alone; the Email column groups them).
 * Question columns: the general questions, then each team's questions for the teams present in
 * `rows`, left blank on rows for other teams. The resume column holds the link the
 * applicant gave, so access to them is controlled by the applicant's own sharing settings.
 */
export function buildExportCsv(rows: readonly ExportRow[], options: { adminBaseUrl: string }): string {
  const teamsPresent = tracks.filter((t) => rows.some((r) => r.track === t.key));
  // A team that has since been removed from the form still exports, with its answers under "Other"
  const teamColumns = teamsPresent.flatMap((t) => questionsForTrack(t.key).map((q) => ({ team: t.key, q, header: `${t.label}: ${q.label}` })));

  const header = uniqueHeaders([
    "Name",
    "Email",
    "UT EID",
    "Grad year",
    "Major",
    "Team",
    "Team status",
    "Submitted (CT)",
    "Submitted automatically",
    "Reviews",
    "Average score",
    "Resume link",
    "Admin link",
    ...genericQuestions.map((q) => q.label),
    ...teamColumns.map((c) => c.header),
  ]);

  const body = rows.map((r) => {
    const general = asRecord(r.genericAnswers);
    const own = asRecord(r.trackAnswers);
    return [
      r.fullName ?? "",
      r.email,
      r.eid ?? "",
      r.gradYear ?? "",
      r.major ?? "",
      getTrack(r.track)?.label ?? r.track,
      TRACK_STATUS_LABEL[r.status],
      stamp(r.submittedAt),
      r.autoSubmitted ? "yes" : "no",
      r.reviewCount,
      r.averageScore === null ? "" : Math.round(r.averageScore * 100) / 100,
      r.resumeUrl ?? "",
      `${options.adminBaseUrl.replace(/\/+$/, "")}/admin/recruiting/${r.applicationId}`,
      ...genericQuestions.map((q) => formatAnswer(q, general[q.id])),
      ...teamColumns.map((c) => (c.team === r.track ? formatAnswer(c.q, own[c.q.id]) : "")),
    ];
  });

  return toCsv(header, body);
}

export function exportFilename(cycleSlug: string, now: Date = new Date()): string {
  return `lsr-recruiting-${cycleSlug}-${formatInTimeZone(now, DEFAULT_TIMEZONE, "yyyy-MM-dd")}.csv`;
}
