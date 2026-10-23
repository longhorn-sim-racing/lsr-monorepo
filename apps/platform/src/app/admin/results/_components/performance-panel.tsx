import Link from "next/link"
import { EmptyState, Panel, PanelHeader, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { formatLap, recentForm, trackRecords, type FormRow, type PerfDriver, type TrackRecord } from "@/lib/race-performance"
import { loadRaceData } from "@/server/queries/race-performance"
import { cn } from "@/lib/utils"

/**
 * Best laps and form (#188), under the uploads: the fastest lap at each track in every ingested
 * session, and each recent driver's last five race finishes. Jack's race_performance tool goes deeper
 * (consistency, incidents, head-to-heads).
 */

/** Recent drivers: everyone in the latest races. Their form: their last few finishes */
const RECENT_RACES = 10
const FORM_RACES = 5

export async function PerformancePanel() {
  const data = await loadRaceData({ withLaps: true })
  const records = trackRecords(data)
  const form = recentForm(data, { races: FORM_RACES, activeSessions: RECENT_RACES })
  if (!records.length && !form.length) {
    return (
      <Panel className="mt-4">
        <PanelHeader title="Best laps and form" />
        <EmptyState title="No ingested results yet" description="Lap records and drivers' recent finishes show here once results are ingested." />
      </Panel>
    )
  }
  return (
    <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <TrackRecords records={records} />
      <Form rows={form} />
    </div>
  )
}

function DriverName({ driver }: { driver: PerfDriver }) {
  return driver.handle ? (
    <Link href={`/drivers/${driver.handle}`} className="font-semibold hover:underline">
      {driver.name}
    </Link>
  ) : (
    <span className="font-semibold" title="Not linked to a member">
      {driver.name}
    </span>
  )
}

function TrackRecords({ records }: { records: TrackRecord[] }) {
  return (
    <Panel>
      <PanelHeader title="Fastest laps by track" description="The best valid lap in any ingested session (practice, qualifying or race)" />
      {records.length ? (
        <Table minWidth={440} className="rounded-none border-0">
          <THead>
            <TH>Track</TH>
            <TH className="text-right">Best lap</TH>
            <TH>Driver</TH>
            <TH className="text-right">Drivers</TH>
          </THead>
          <tbody>
            {records.map((record) => (
              <TR key={record.track}>
                <TD className="max-w-48 truncate" title={record.track}>
                  {record.track}
                </TD>
                <TD className="text-right font-mono text-xs">{formatLap(record.bestLapMs)}</TD>
                <TD>
                  <DriverName driver={record.driver} />
                </TD>
                <TD className="text-right text-muted-foreground">{record.drivers}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No lap times yet" />
      )}
    </Panel>
  )
}

function Form({ rows }: { rows: FormRow[] }) {
  return (
    <Panel>
      <PanelHeader title="Form" description={`Each driver from the last ${RECENT_RACES} races: their last ${FORM_RACES} finishes, oldest first`} />
      {rows.length ? (
        <Table minWidth={480} className="rounded-none border-0">
          <THead>
            <TH>Driver</TH>
            <TH>Finishes</TH>
            <TH className="text-right">Average</TH>
            <TH className="text-right">Gained</TH>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TR key={row.driver.key}>
                <TD>
                  <DriverName driver={row.driver} />
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {row.races.map((race, i) => (
                      <span
                        key={i}
                        title={`${race.event?.title ?? race.track}: P${race.position} of ${race.field}${race.dsq ? " (disqualified)" : ""}`}
                        className={cn(
                          "inline-flex h-5 min-w-7 items-center justify-center rounded px-1 text-[11px] font-semibold tabular-nums",
                          race.dsq ? "bg-tone-danger text-tone-danger-foreground" : race.position <= 3 ? "bg-primary/15 text-foreground" : "bg-admin-surface text-muted-foreground",
                        )}
                      >
                        {race.dsq ? "DSQ" : `P${race.position}`}
                      </span>
                    ))}
                  </span>
                </TD>
                <TD className="text-right">{row.averageFinish?.toFixed(1) ?? "—"}</TD>
                <TD className="text-right text-muted-foreground">{row.gained === null ? "—" : row.gained > 0 ? `+${row.gained}` : row.gained}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No races yet" />
      )}
      <p className="border-t border-admin-row px-4 py-2.5 text-xs text-admin-subtle">
        No DNF is recorded in results files: a driver who stopped early still shows a finish. Gained compares qualifying to the race where both were uploaded.
      </p>
    </Panel>
  )
}
