import type { Metadata } from "next"
import Link from "next/link"
import { formatDistanceStrict } from "date-fns"
import { formatInTimeZone } from "date-fns-tz"
import { Badge, Notice, PageHeader, Panel, PanelHeader, Stat, StatRow } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { DIGEST_JOB_KEY, RECURRING_PAGE } from "@/lib/jack/recurring"
import { formatUsd } from "@/lib/jack/spend"
import { jackRoomTitle } from "@/lib/jack/types"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { requireOfficerPage } from "@/server/auth/guards"
import { automationBudgetUsd, automationSpendUsd } from "@/server/automation/cap"
import { discordDigestText, roomDigestText } from "@/server/automation/digest/render"
import { loadDigestJob } from "@/server/automation/digest/settings"
import { listRecurringQuestions, roomChoices } from "@/server/automation/recurring/queries"
import { runDigestChecks } from "@/server/automation/run-checks"
import { discordConnector } from "@/server/connectors/discord/connector"
import { teamsWebhookConnector } from "@/server/connectors/teams-webhook/connector"
import { prisma } from "@/server/db"
import { postingChannels } from "@/server/discord-post/channels"
import { heartbeatState, HEARTBEAT_ID } from "@/server/scheduler/heartbeat"
import { describeSchedule } from "@/server/scheduler/schedule"
import { getSiteUrl } from "@/lib/site-url"
import { userNames } from "@/server/services/officers"
import { DigestForm, type DigestFormView } from "./_components/digest-form"
import { NewQuestionButton, QuestionList, type QuestionView } from "./_components/questions"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Recurring questions · Jack" }

const when = (date: Date | null | undefined) => (date ? `${formatInTimeZone(date, DEFAULT_TIMEZONE, "EEE, MMM d, h:mm a")} CT` : null)

/**
 * Jack → Recurring questions (#188, design §11 and §13): questions Jack is asked on a schedule in a room
 * (create, edit, switch, ask now, delete; each one's last runs with their answer and cost, and an
 * estimated monthly cost), and the weekly digest's settings. Officers only; where the digest posts
 * outside the console is an admin's call. Automations share their own monthly cap.
 */
export default async function RecurringQuestionsPage({ searchParams }: { searchParams: Promise<{ q?: string; preview?: string }> }) {
  await requireOfficerPage()
  const { q: highlight, preview } = await searchParams
  const now = new Date()
  const [session, questions, rooms, digest, spentUsd, heartbeat] = await Promise.all([
    getCachedSessionUser(),
    listRecurringQuestions(now),
    roomChoices(),
    loadDigestJob(now),
    automationSpendUsd(now),
    prisma.schedulerHeartbeat.findUnique({ where: { id: HEARTBEAT_ID }, select: { lastTickAt: true } }),
  ])
  const isAdmin = session.roles.includes("admin")
  const capUsd = automationBudgetUsd()
  const ticking = heartbeatState(heartbeat?.lastTickAt ?? null, now) === "ok"

  const views: QuestionView[] = questions.map((question) => ({
    id: question.id,
    title: question.title,
    prompt: question.prompt,
    persona: question.persona,
    roomId: question.roomId,
    roomTitle: question.roomTitle,
    roomArchived: question.roomArchived,
    owner: question.owner,
    schedule: question.schedule,
    scheduleText: question.scheduleText,
    enabled: question.enabled,
    pausedReason: question.pausedReason,
    nextRun: question.nextRunAt ? `${when(question.nextRunAt)} (${formatDistanceStrict(question.nextRunAt, now, { addSuffix: true })})` : null,
    lastAsked: when(question.lastRunAt),
    estimate: { monthlyUsd: question.estimate.monthlyUsd, perRunUsd: question.estimate.perRunUsd, runs: Math.round(question.estimate.runsPerMonth), basis: question.estimate.basis },
    monthUsd: question.monthUsd,
    runs: question.runs.map((run) => ({ id: run.id, at: when(run.startedAt)!, status: run.status, summary: run.summary, reply: run.reply, waiting: run.waiting })),
  }))
  const on = views.filter((v) => v.enabled)
  const estimatedUsd = on.reduce((sum, v) => sum + v.estimate.monthlyUsd, 0)

  // The digest: its settings, what it last posted, and (on request) what it would post now
  const [configuredBy, discordChannels, discordOn, teams, lastNote, previewReport] = await Promise.all([
    digest.config.configuredById ? userNames([digest.config.configuredById]).then((names) => names.get(digest.config.configuredById!)?.displayName ?? "a former officer") : null,
    // Only the posting channels: the digest posts where every other post may (Community → Announcements)
    postingChannels().then((channels) => channels.map(({ id, name }) => ({ id, name }))),
    discordConnector.status().then((status) => status.state === "connected"),
    teamsWebhookConnector.status(),
    prisma.jackMessage.findFirst({ where: { jobKey: DIGEST_JOB_KEY }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, roomId: true, createdAt: true } }),
    preview === "digest" ? runDigestChecks({ now }) : null,
  ])
  const digestView: DigestFormView = {
    enabled: digest.job.enabled,
    roomId: digest.config.roomId ?? "",
    day: digest.day,
    time: digest.time,
    summary: digest.config.summary,
    discordChannelId: digest.config.discordChannelId ?? "",
    teams: digest.config.teams,
    scheduleText: describeSchedule(digest.job.schedule) ?? digest.job.schedule,
    nextRun: digest.job.enabled ? when(digest.job.nextRunAt) : null,
    lastRun: digest.job.lastRunAt ? { at: when(digest.job.lastRunAt)!, status: digest.job.lastStatus } : null,
    lastNote: lastNote ? { href: `/admin/jack/${lastNote.roomId}?m=${encodeURIComponent(lastNote.id)}`, at: when(lastNote.createdAt)! } : null,
    configured: configuredBy && digest.config.configuredAt ? `${configuredBy}, ${when(new Date(digest.config.configuredAt))}` : null,
    discordChannels,
    discordConnected: discordOn,
    teamsState: teams.state,
    teamsHost: teams.details?.find((d) => d.label === "Posts through")?.value ?? null,
  }
  const previewTexts = previewReport
    ? {
        room: roomDigestText(previewReport, { setUpBy: configuredBy ?? session.user?.displayName ?? "you", askSummary: digest.config.summary }),
        outside: discordDigestText(previewReport, getSiteUrl()),
      }
    : null

  return (
    <>
      <PageHeader
        title="Recurring questions"
        back={{ href: "/admin/jack", label: "Jack" }}
        description={`Questions Jack is asked on a schedule, and the weekly digest. Automations share ${formatUsd(capUsd, { wholeIfRound: true })} a month of Jack's budget; past it they're skipped until the 1st.`}
        actions={<NewQuestionButton rooms={rooms} />}
      />

      {!ticking ? (
        <Notice tone="warning" title="The scheduler isn't ticking" className="mb-4">
          Nothing here runs until it does. <Link href="/admin/jobs" className="font-semibold underline">Scheduled jobs</Link> shows why.
        </Notice>
      ) : null}

      <StatRow>
        <Stat label="On" value={on.length} hint={`${views.length - on.length} off`} />
        <Stat label="Estimated a month" value={formatUsd(estimatedUsd)} hint="The questions that are on, at their schedules" />
        <Stat
          label="Automations this month"
          value={`${formatUsd(spentUsd)} of ${formatUsd(capUsd, { wholeIfRound: true })}`}
          hint={spentUsd >= capUsd ? "Cap reached: skipped until the 1st" : "Recurring questions and digest summaries (Jack → Usage)"}
        />
      </StatRow>

      <Panel className="mb-4">
        <PanelHeader title="Questions" description="Each is asked in its room as the officer who set it up, answered with no web search and without saving knowledge. Pick “Last runs” to see each answer and what it cost." />
        <QuestionList questions={views} rooms={rooms} highlight={highlight ?? null} />
      </Panel>

      <Panel id="digest" className="scroll-mt-4">
        <PanelHeader
          title="Weekly digest"
          description="Every “needs attention” check from across the console, posted once a week: the full list to a Jack room, with an optional short summary from Jack, and only counts and links to Discord or Teams."
          actions={
            <Badge tone={digest.job.enabled ? "success" : "neutral"}>{digest.job.enabled ? "On" : "Off"}</Badge>
          }
        />
        <DigestForm view={digestView} rooms={rooms} isAdmin={isAdmin} />
        <div className="border-t border-admin-row px-4 py-3 text-xs text-admin-subtle">
          {previewTexts ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-foreground">What it would post now</span>
                <Link href={`${RECURRING_PAGE}#digest`} className="hover:text-foreground hover:underline">
                  Hide
                </Link>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <figure className="flex min-w-0 flex-col gap-1">
                  <figcaption>In the room{digestView.roomId ? ` (${jackRoomTitle({ title: rooms.find((r) => r.id === digestView.roomId)?.title ?? null })})` : ""}</figcaption>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-admin-surface p-3 font-sans text-xs leading-relaxed text-muted-foreground">{previewTexts.room}</pre>
                </figure>
                <figure className="flex min-w-0 flex-col gap-1">
                  <figcaption>On Discord and Teams (counts and links only)</figcaption>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-admin-surface p-3 font-sans text-xs leading-relaxed text-muted-foreground">{previewTexts.outside}</pre>
                </figure>
              </div>
            </div>
          ) : (
            <Link href={`${RECURRING_PAGE}?preview=digest#digest`} className="font-semibold text-foreground hover:underline">
              Preview what it would post now
            </Link>
          )}
        </div>
      </Panel>
    </>
  )
}
