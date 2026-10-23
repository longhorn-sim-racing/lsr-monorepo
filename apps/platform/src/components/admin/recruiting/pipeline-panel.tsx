import Link from "next/link";
import { Panel, PanelFooter, PanelHeader, Table, TD, TH, THead, TR } from "@/components/admin/kit";
import { TRACK_STATUS_LABEL, TRACK_STATUS_ORDER } from "@/lib/recruiting/labels";
import type { PipelinePanelData } from "@/server/queries/recruiting-pipeline";

/**
 * The round's pipeline at a glance (#188): team applications per team and status, how many nobody
 * has reviewed or decided yet, average scores, and who has written how many reviews. Server-rendered;
 * team names filter the list below.
 */
export function PipelinePanel({ data, teamHref }: { data: PipelinePanelData; teamHref: (team: string) => string }) {
  const score = (value: number | null) => (value === null ? "—" : value.toFixed(1));
  const waiting = data.teams.filter((t) => t.longestWaitDays !== null).sort((a, b) => (b.longestWaitDays ?? 0) - (a.longestWaitDays ?? 0))[0];
  return (
    <Panel className="mb-4">
      <PanelHeader
        title="Pipeline"
        description={`Team applications in this round by status. "No review yet" counts the ones nobody has reviewed or decided.${data.ownApplication ? " Reviews of your own application are left out." : ""}`}
      />
      <Table minWidth={760} className="rounded-none border-0">
        <THead>
          <TH>Team</TH>
          <TH className="text-right">Applied</TH>
          {TRACK_STATUS_ORDER.map((status) => (
            <TH key={status} className="text-right">
              {TRACK_STATUS_LABEL[status]}
            </TH>
          ))}
          <TH className="text-right">No review yet</TH>
          <TH className="text-right">Avg score</TH>
        </THead>
        <tbody>
          {data.teams.map((team) => (
            <TR key={team.team}>
              <TD>
                <Link href={teamHref(team.team)} className="font-semibold hover:underline">
                  {team.label}
                </Link>
              </TD>
              <TD className="text-right">{team.total}</TD>
              {TRACK_STATUS_ORDER.map((status) => (
                <TD key={status} className="text-right text-muted-foreground">
                  {team.byStatus[status] || "—"}
                </TD>
              ))}
              <TD className={team.unreviewed ? "text-right font-semibold" : "text-right text-muted-foreground"}>{team.unreviewed || "—"}</TD>
              <TD className="text-right">{score(team.averageScore)}</TD>
            </TR>
          ))}
          <TR className="bg-admin-surface font-semibold">
            <TD>All teams</TD>
            <TD className="text-right">{data.total}</TD>
            {TRACK_STATUS_ORDER.map((status) => (
              <TD key={status} className="text-right">
                {data.byStatus[status]}
              </TD>
            ))}
            <TD className="text-right">{data.unreviewed}</TD>
            <TD className="text-right">{score(data.averageScore)}</TD>
          </TR>
        </tbody>
      </Table>
      <PanelFooter className="text-xs text-muted-foreground">
        <span>
          {data.reviewers.length
            ? `Reviews: ${data.reviewers.map((r) => `${r.name} ${r.reviews}`).join(" · ")}`
            : "No reviews written yet."}
        </span>
        {waiting && waiting.longestWaitDays !== null ? (
          <span>
            Longest wait without a review: {waiting.longestWaitDays} {waiting.longestWaitDays === 1 ? "day" : "days"} ({waiting.label})
          </span>
        ) : null}
      </PanelFooter>
    </Panel>
  );
}
