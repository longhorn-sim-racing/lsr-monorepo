import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { Badge, DetailList, EmptyState, Notice, PageHeader, Panel, PanelBody, PanelHeader, SplitLayout } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { activityLabel, daysSince, QUIET_PROSPECT_DAYS, TIER_LABEL } from "@/lib/sponsor-prospects"
import { requireOfficerPage } from "@/server/auth/guards"
import { centralDate } from "@/server/jack/tools/time"
import { getProspectDetail } from "@/server/queries/sponsor-prospects"
import { listOfficers, type OfficerRef } from "@/server/services/officers"
import { ActivityForm, ActivityMenu, DeleteProspectButton } from "../_components/activity-form"
import { hostOf, StageBadge } from "../_components/labels"
import { ProspectForm } from "../_components/prospect-form"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Sponsor prospect" }

const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE, MMM d, yyyy")
const dateInput = (date: Date | null) => (date ? formatInTimeZone(date, DEFAULT_TIMEZONE, "yyyy-MM-dd") : "")
const who = (person: OfficerRef | null, id: string | null) => person?.displayName ?? (id ? "Former officer" : "Someone")

/** One sponsor prospect: its activity timeline (and logging more), and its details to edit */
export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const now = new Date()
  const [prospect, officers] = await Promise.all([getProspectDetail(id, now), listOfficers()])
  if (!prospect) notFound()

  // A former officer who still owns it stays selectable, so saving the form doesn't drop them by accident
  const owners = prospect.owner && !officers.some((o) => o.id === prospect.owner!.id) ? [...officers, prospect.owner] : officers

  return (
    <>
      <PageHeader
        back={{ href: "/admin/sponsors", label: "Sponsors" }}
        title={prospect.company}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StageBadge stage={prospect.stage} />
            {prospect.tierInterest && <span>{TIER_LABEL[prospect.tierInterest as keyof typeof TIER_LABEL] ?? prospect.tierInterest} interest</span>}
            <span>{prospect.owner ? `Owner: ${prospect.owner.displayName}` : "No owner"}</span>
            {prospect.website && (
              <a href={prospect.website} target="_blank" rel="noreferrer" className="font-medium text-foreground hover:underline">
                {hostOf(prospect.website)}
              </a>
            )}
          </span>
        }
        actions={<DeleteProspectButton id={prospect.id} company={prospect.company} />}
      />

      <SplitLayout
        main={
          <div className="flex flex-col gap-4">
            {prospect.quiet && (
              <Notice tone="warning" title={`Nothing logged for ${daysSince(prospect.lastTouchAt, now)} days`}>
                It&apos;s in {prospect.stage === "talking" ? "Talking" : "Contacted"}, and prospects there count as quiet after {QUIET_PROSPECT_DAYS} days. Log the latest, or follow up.
              </Notice>
            )}
            {prospect.nextStep && (
              <Notice tone={prospect.nextStepOverdue ? "warning" : "info"} title={`Next step${prospect.nextStepDue ? `, ${prospect.nextStepOverdue ? "was due" : "due"} ${day(prospect.nextStepDue)}` : ""}`}>
                {prospect.nextStep}
              </Notice>
            )}
            <Panel>
              <PanelHeader title="Log activity" description="An email, a reply, a call, a meeting or a note. Emails, replies, calls and meetings count as contact." />
              <PanelBody>
                <ActivityForm prospectId={prospect.id} stage={prospect.stage} today={centralDate(now)} />
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="Activity" description={prospect.activities.length ? `${prospect.activities.length} ${prospect.activities.length === 1 ? "entry" : "entries"}, newest first` : undefined} />
              {prospect.activities.length === 0 ? (
                <EmptyState title="Nothing logged yet" description="Log the first contact above. Stage changes show up here too." />
              ) : (
                <ol className="flex flex-col">
                  {prospect.activities.map((activity) => (
                    <li key={activity.id} className="flex items-start justify-between gap-3 border-b border-admin-row px-4 py-2.5 text-[13px] last:border-b-0">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {activity.type === "stage_change" ? <Badge>{activityLabel(activity.type)}</Badge> : <span className="font-semibold">{activityLabel(activity.type)}</span>}
                          <span className="text-xs text-admin-subtle">
                            {day(activity.occurredAt)} · {who(activity.by, activity.byId)}
                          </span>
                        </span>
                        <p className="whitespace-pre-wrap break-words">{activity.summary}</p>
                      </div>
                      {activity.type !== "stage_change" && <ActivityMenu activityId={activity.id} label={`${activityLabel(activity.type)} on ${day(activity.occurredAt)}`} />}
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>
        }
        side={
          <div className="flex flex-col gap-4">
            <ProspectForm
              // A fresh form after every change, so an edit is always made from what the page shows
              key={prospect.updatedAt.toISOString()}
              compact
              id={prospect.id}
              owners={owners}
              initial={{
                company: prospect.company,
                website: prospect.website ?? "",
                contactName: prospect.contactName ?? "",
                contactEmail: prospect.contactEmail ?? "",
                contactRole: prospect.contactRole ?? "",
                stage: prospect.stage,
                tierInterest: prospect.tierInterest ?? "",
                ownerId: prospect.owner?.id ?? "",
                nextStep: prospect.nextStep ?? "",
                nextStepDue: dateInput(prospect.nextStepDue),
                notes: prospect.notes ?? "",
              }}
            />
            <Panel>
              <PanelHeader title="Details" />
              <PanelBody>
                <DetailList
                  items={[
                    { label: "Last contact", value: prospect.lastContactAt ? day(prospect.lastContactAt) : <span className="text-admin-subtle">None logged</span> },
                    { label: "Added", value: `${day(prospect.createdAt)} by ${who(prospect.createdBy, prospect.createdById)}` },
                    { label: "Last change", value: day(prospect.updatedAt) },
                  ]}
                />
              </PanelBody>
            </Panel>
          </div>
        }
      />
    </>
  )
}
