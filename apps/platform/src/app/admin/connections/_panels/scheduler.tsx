import { Panel, PanelBody, PanelHeader } from "@/components/admin/kit"

/**
 * SLOT for G3 (the scheduler): the scheduler's heartbeat on the Connections page, from
 * SchedulerHeartbeat ("Last tick 2 min ago", or "Never" when pg_cron isn't calling), with a link to
 * Scheduled jobs (/admin/jobs). G3 replaces this placeholder and nothing else on the page. It's a server
 * component that loads its own data; the page renders it through SafeSlot, so a throw here shows a
 * short notice instead of breaking the page.
 */
export async function SchedulerPanel() {
  return (
    <Panel>
      <PanelHeader title="Scheduler" description="Runs the sync jobs and other scheduled work when it's due." />
      <PanelBody>
        <p className="text-[13px] text-admin-subtle">Not built yet. When the scheduler last ran shows here once it&apos;s set up.</p>
      </PanelBody>
    </Panel>
  )
}
