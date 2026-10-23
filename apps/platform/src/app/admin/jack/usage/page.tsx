import type { Metadata } from "next"
import Link from "next/link"
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, StatRow, Table, TD, TH, THead, TR, type Tone } from "@/components/admin/kit"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { formatUsd } from "@/lib/jack/spend"
import { JACK_PERSONA_NAME, jackRoomTitle, type JackPersonaKey } from "@/lib/jack/types"
import { cn } from "@/lib/utils"
import { requireOfficerPage } from "@/server/auth/guards"
import { getUsageOverview, monthKeyOf, type MonthCost, type Spender, type SpenderKind, type ThumbsDown } from "@/server/jack/usage"
import { UsageMonthSelect } from "./month-select"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Usage · Jack" }

const PERSONAS: JackPersonaKey[] = ["jack", "lift", "stand"]
const PERSONA_HINT: Record<JackPersonaKey, string> = { jack: "Sonnet, the default", lift: "Opus, for harder questions", stand: "Haiku, quick tasks and room names" }
const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/**
 * Jack → Usage (#188, design §10 and §13): what Jack cost by month, persona, officer and automation
 * against the monthly cap; how officers rated his replies, with thumbs-down notes as eval candidates; and
 * what officers ask him first. Officers only.
 */
export default async function JackUsagePage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  await requireOfficerPage()
  const usage = await getUsageOverview((await searchParams).month)
  const { month, selected, budgetUsd, feedback } = usage
  const thisMonth = monthKeyOf(new Date())
  const options = usage.months.map((m) => ({ key: m.month.key, label: m.month.label }))
  if (!options.some((o) => o.key === month.key)) options.push({ key: month.key, label: month.label })
  const share = (usd: number) => (selected.totalUsd > 0 ? `${Math.round((usd / selected.totalUsd) * 100)}% of the month` : "Nothing spent")

  return (
    <>
      <PageHeader
        title="Usage"
        back={{ href: "/admin/jack", label: "Jack" }}
        description={`What Jack costs, who it's for, and how officers rate his answers · capped at ${formatUsd(budgetUsd, { wholeIfRound: true })} a month (Central Time)`}
        actions={<UsageMonthSelect months={options} value={month.key} current={thisMonth} />}
      />

      <StatRow>
        <Stat label={`Spent in ${month.label}`} value={formatUsd(selected.totalUsd)} hint={<CapMeter usd={selected.totalUsd} budgetUsd={budgetUsd} current={usage.current} />} />
        <Stat label="Replies" value={selected.replies.toLocaleString("en-US")} hint="Answers from Jack, Lift or Stand" />
        {PERSONAS.map((persona) => (
          <Stat key={persona} label={JACK_PERSONA_NAME[persona]} value={formatUsd(selected.byPersona[persona])} hint={`${PERSONA_HINT[persona]} · ${share(selected.byPersona[persona])}`} />
        ))}
        <Stat
          label="Ratings"
          value={`${feedback.counts.up} up · ${feedback.counts.down} down`}
          hint={feedback.counts.notes ? `${feedback.counts.notes} thumbs-down with a note` : "Thumbs on replies this month"}
        />
      </StatRow>

      <div className="mb-4 grid items-start gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Cost by month" description="The last twelve months, Central Time. Pick one to see it below." />
          <MonthTable months={usage.months} selected={month.key} current={thisMonth} budgetUsd={budgetUsd} />
        </Panel>
        <Panel>
          <PanelHeader
            title={`By officer and automation · ${month.label}`}
            description="A reply counts for the officer whose message started it; replies to recurring questions and side jobs count apart."
          />
          <SpenderTable spenders={usage.spenders} total={selected.totalUsd} />
        </Panel>
      </div>

      <Panel className="mb-4" id="feedback">
        <PanelHeader
          title={`Thumbs-down · ${month.label}`}
          description="Newest first. One with a note is an eval candidate: a question to add to Jack's test set (scripts/jack-eval)."
        />
        <ThumbsDownList items={feedback.down} total={feedback.counts.down} />
      </Panel>

      <Panel>
        <PanelHeader
          title={`Common questions · ${month.label}`}
          description={`Words that come up in the first question to Jack in the most rooms opened this month (${usage.rooms} ${usage.rooms === 1 ? "room" : "rooms"} with a question). Everyday words are left out, and words aren't merged: "event" and "events" count apart.`}
        />
        {usage.words.length ? (
          <Table minWidth={560} className="rounded-none border-0">
            <THead>
              <TH>Word</TH>
              <TH className="text-right">Rooms</TH>
              <TH>Rooms it came up in</TH>
            </THead>
            <tbody>
              {usage.words.map((word) => (
                <TR key={word.word}>
                  <TD className="align-top font-semibold">{word.word}</TD>
                  <TD className="text-right align-top">{word.rooms}</TD>
                  <TD className="align-top">
                    <ul className="flex flex-col gap-0.5">
                      {word.examples.map((example) => (
                        <li key={example.roomId} className="min-w-0">
                          <Link href={`/admin/jack/${example.roomId}`} title={example.question} className="line-clamp-1 break-words text-muted-foreground hover:text-foreground hover:underline">
                            {jackRoomTitle(example)}: <span className="text-admin-subtle">{example.question}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            title={usage.rooms ? "No word comes up in two rooms yet" : "No rooms opened this month"}
            description="A word shows here once it's in the first question of at least two rooms."
          />
        )}
      </Panel>
    </>
  )
}

/** This month against the cap: a meter whose fill turns from blue to amber at 80% and red at the cap, with the same words beside it */
function CapMeter({ usd, budgetUsd, current }: { usd: number; budgetUsd: number; current: boolean }) {
  const ratio = budgetUsd > 0 ? usd / budgetUsd : 1
  const level = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "info"
  const percent = Math.round(Math.min(ratio, 1) * 100)
  const label =
    ratio >= 1
      ? current
        ? "Cap reached: replies pause until the 1st"
        : "Reached the cap"
      : `${Math.round(ratio * 100)}% of the ${formatUsd(budgetUsd, { wholeIfRound: true })} cap`
  return (
    <span className="flex flex-col gap-1">
      <Meter percent={percent} level={level} label={`${formatUsd(usd)} of ${formatUsd(budgetUsd, { wholeIfRound: true })}`} />
      <span className={cn(level !== "info" && "font-medium", level === "danger" ? "text-tone-danger-foreground" : level === "warning" ? "text-tone-warning-foreground" : undefined)}>{label}</span>
    </span>
  )
}

const METER: Record<"info" | "warning" | "danger", { track: string; fill: string }> = {
  info: { track: "bg-tone-info", fill: "bg-tone-info-foreground" },
  warning: { track: "bg-tone-warning", fill: "bg-tone-warning-foreground" },
  danger: { track: "bg-tone-danger", fill: "bg-tone-danger-foreground" },
}

/** A thin track with a rounded fill, the track a lighter step of the fill's color */
function Meter({ percent, level, label, className }: { percent: number; level: keyof typeof METER; label: string; className?: string }) {
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label} title={label} className={cn("block h-1.5 w-full overflow-hidden rounded-full", METER[level].track, className)}>
      <span className={cn("block h-full rounded-full", METER[level].fill)} style={{ width: `${percent}%` }} />
    </span>
  )
}

function MonthTable({ months, selected, current, budgetUsd }: { months: MonthCost[]; selected: string; current: string; budgetUsd: number }) {
  return (
    <Table minWidth={600} className="rounded-none border-0">
      <THead>
        <TH>Month</TH>
        {PERSONAS.map((persona) => (
          <TH key={persona} className="text-right">
            {JACK_PERSONA_NAME[persona]}
          </TH>
        ))}
        <TH className="text-right">Total</TH>
        <TH className="text-right">Replies</TH>
        <TH className="w-28">Of the cap</TH>
      </THead>
      <tbody>
        {months.map(({ month, byPersona, totalUsd, replies }) => {
          const ratio = budgetUsd > 0 ? totalUsd / budgetUsd : 1
          return (
            <TR key={month.key} selected={month.key === selected}>
              <TD className="whitespace-nowrap">
                <Link href={month.key === current ? "/admin/jack/usage" : `/admin/jack/usage?month=${month.key}`} aria-current={month.key === selected ? "true" : undefined} className="font-semibold hover:underline">
                  {month.label}
                </Link>
              </TD>
              {PERSONAS.map((persona) => (
                <TD key={persona} className={cn("text-right", !byPersona[persona] && "text-admin-subtle")}>
                  {byPersona[persona] ? formatUsd(byPersona[persona]) : "—"}
                </TD>
              ))}
              <TD className="text-right font-semibold">{formatUsd(totalUsd)}</TD>
              <TD className="text-right text-muted-foreground">{replies.toLocaleString("en-US")}</TD>
              <TD>
                <Meter
                  percent={Math.round(Math.min(ratio, 1) * 100)}
                  level={ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "info"}
                  label={`${month.label}: ${formatUsd(totalUsd)}, ${Math.round(ratio * 100)}% of today's ${formatUsd(budgetUsd, { wholeIfRound: true })} cap`}
                />
              </TD>
            </TR>
          )
        })}
      </tbody>
    </Table>
  )
}

const SPENDER_KIND: Record<SpenderKind, { label: string; tone: Tone }> = {
  officer: { label: "Officer", tone: "neutral" },
  automation: { label: "Automation", tone: "info" },
  side_job: { label: "Side job", tone: "neutral" },
  unlinked: { label: "Other", tone: "neutral" },
}

function SpenderTable({ spenders, total }: { spenders: Spender[]; total: number }) {
  if (!spenders.length) return <EmptyState title="Nothing spent this month" description="Replies and side jobs show here once Jack answers something." />
  return (
    <Table minWidth={460} className="rounded-none border-0">
      <THead>
        <TH>Who</TH>
        <TH className="text-right">Calls</TH>
        <TH className="text-right">Cost</TH>
        <TH className="text-right">Share</TH>
      </THead>
      <tbody>
        {spenders.map((spender) => (
          <TR key={spender.key}>
            <TD>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-semibold">{spender.label}</span>
                {spender.kind !== "officer" ? <Badge tone={SPENDER_KIND[spender.kind].tone}>{SPENDER_KIND[spender.kind].label}</Badge> : null}
              </span>
            </TD>
            <TD className="text-right text-muted-foreground">{spender.calls.toLocaleString("en-US")}</TD>
            <TD className="text-right font-semibold">{formatUsd(spender.costUsd)}</TD>
            <TD className="text-right text-muted-foreground">{total > 0 ? `${Math.round((spender.costUsd / total) * 100)}%` : "—"}</TD>
          </TR>
        ))}
      </tbody>
    </Table>
  )
}

function ThumbsDownList({ items, total }: { items: ThumbsDown[]; total: number }) {
  if (!items.length) return <EmptyState title="No thumbs-down this month" description="Officers rate replies with the thumbs under each answer in a room." />
  return (
    <>
      <ul>
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1.5 border-b border-admin-row px-4 py-3 last:border-b-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-admin-subtle">
              {item.note ? <Badge tone="warning">Eval candidate</Badge> : null}
              <Link href={roomMessageUrl(item.roomId, item.messageId)} className="font-semibold text-foreground hover:underline">
                {jackRoomTitle({ title: item.roomTitle })}
              </Link>
              <span>
                {item.by} · {when.format(item.at)} CT
              </span>
            </span>
            {item.note ? <p className="whitespace-pre-wrap break-words text-[13px] font-medium">“{item.note}”</p> : <p className="text-[13px] text-admin-subtle">No note</p>}
            <dl className="grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
              {item.question ? (
                <>
                  <dt className="text-admin-subtle">Asked</dt>
                  <dd className="min-w-0 break-words text-muted-foreground">{item.question}</dd>
                </>
              ) : null}
              <dt className="text-admin-subtle">Answer</dt>
              <dd className="min-w-0 break-words text-muted-foreground">{item.reply || "(no text)"}</dd>
            </dl>
          </li>
        ))}
      </ul>
      {total > items.length ? <p className="border-t border-admin-row px-4 py-2.5 text-xs text-admin-subtle">Showing the newest {items.length} of {total}.</p> : null}
    </>
  )
}
