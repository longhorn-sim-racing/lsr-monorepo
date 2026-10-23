import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Badge, EmptyState, Notice, Panel, PanelBody, PanelHeader, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { PartLink } from "@/components/jack/parts/part-link"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { deckPageUrl } from "@/lib/jack/decks"
import { PUBLISH_STATUS, TYPE_LABEL } from "@/lib/jack/publish"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { instagramPublishConnector } from "@/server/connectors/instagram/publish-connector"
import { publishAccount } from "@/server/connectors/instagram/publish-token"
import { countWaitingPublishes, listPublishes, publishFollowUpOn } from "@/server/queries/instagram-publish"
import { connectionBadge } from "../../streams/format"
import { CheckPublishButton, PublishConnectionPanel } from "./publishing-client"
import type { InstagramSection } from "./types"

const when = (date: Date | string) => `${formatInTimeZone(new Date(date), DEFAULT_TIMEZONE, "MMM d, h:mm a")} CT`
const day = (iso: string) => formatInTimeZone(new Date(iso), DEFAULT_TIMEZONE, "MMM d, yyyy")

/**
 * Publishing on Content → Instagram (#188, design §13): the publishing token (admins connect it), and
 * every post officers approved from a deck (a Jack card, or the deck page's Publish button) with how it
 * went. A post still on its way can be checked now. Nothing here calls Instagram on load.
 */
async function PublishingSection() {
  const [session, status, account, history, waiting, followUp] = await Promise.all([
    getCachedSessionUser(),
    instagramPublishConnector.status(),
    publishAccount(),
    listPublishes({ limit: 30 }),
    countWaitingPublishes(),
    publishFollowUpOn(),
  ])
  const isAdmin = session.roles.includes("admin")
  const badge = connectionBadge(status.state)

  return (
    <Panel id="publishing" className="scroll-mt-16">
      <PanelHeader
        title="Publishing"
        description="Posts officers approved from a deck: a card in a Jack room, or a deck's Publish to Instagram button. Edit or delete a post in the Instagram app."
        actions={<Badge tone={badge.tone}>{badge.label}</Badge>}
      />
      <PanelBody className="flex flex-col gap-4">
        {status.state === "error" && (
          <Notice tone="danger" title="Publishing is failing">
            {status.lastError}
          </Notice>
        )}
        {account.refreshError && (
          <Notice tone="danger" title="The publishing token couldn't be renewed">
            {account.refreshError}
          </Notice>
        )}
        {status.state === "off" && (
          <Notice tone="info" title="Publishing is switched off">
            The token is saved. An admin runs its smoke test and switches Instagram publishing on in{" "}
            <Link href="/admin/connections" className="underline underline-offset-2">
              System → Connections
            </Link>
            , and turns on its two jobs in{" "}
            <Link href="/admin/jobs" className="underline underline-offset-2">
              Scheduled jobs
            </Link>
            .
          </Notice>
        )}
        {status.state === "not_configured" && account.connected && status.missingEnv.length > 0 && (
          <Notice tone="warning" title="Cloudinary isn't set up on this server">
            Posting needs {status.missingEnv.join(", ")} (Instagram downloads the slides from Cloudinary). Ask the Tech Team.
          </Notice>
        )}
        {waiting > 0 && !followUp && (
          <Notice tone="warning" title={`${waiting === 1 ? "A post is" : `${waiting} posts are`} waiting on Instagram, and the follow-up job is off`}>
            Use Check now below, or turn on <span className="font-medium">instagram-publish.finish</span> in{" "}
            <Link href="/admin/jobs" className="underline underline-offset-2">
              Scheduled jobs
            </Link>{" "}
            so waiting posts go up on their own.
          </Notice>
        )}

        <PublishConnectionPanel
          isAdmin={isAdmin}
          connection={{
            connected: account.connected,
            username: account.username ?? null,
            connectedAt: account.connectedAt ? day(account.connectedAt) : null,
            tokenExpires: account.tokenExpiresAt ? day(account.tokenExpiresAt) : null,
            refreshError: account.refreshError ?? null,
          }}
        />

        {history.length ? (
          <Table minWidth={860}>
            <THead>
              <TH>Approved</TH>
              <TH>What</TH>
              <TH>Caption</TH>
              <TH>Status</TH>
              <TH>By</TH>
              <TH>Post</TH>
            </THead>
            <tbody>
              {history.map((row) => {
                const tone = PUBLISH_STATUS[row.status]
                return (
                  <TR key={row.id}>
                    <TD className="whitespace-nowrap align-top">{when(row.createdAt)}</TD>
                    <TD className="align-top">
                      <div className="flex items-start gap-2">
                        {row.thumbUrl && (
                          // eslint-disable-next-line @next/next/no-img-element -- an officer-only route (or the public copy); next/image can't pass the session
                          <img src={row.thumbUrl} alt="" loading="lazy" className="size-10 shrink-0 rounded-[3px] border bg-[#0B0B0B] object-contain" />
                        )}
                        <div className="flex min-w-0 flex-col">
                          {row.deck ? (
                            <Link href={deckPageUrl(row.deck.id)} className="font-medium underline-offset-2 hover:underline">
                              {row.deck.title}
                            </Link>
                          ) : (
                            <span className="text-admin-subtle">A deleted deck</span>
                          )}
                          <span className="text-xs text-admin-subtle">
                            {TYPE_LABEL[row.mediaType]}
                            {row.mediaType === "CAROUSEL" ? ` of ${row.slides} slides` : ""}
                            {row.deck?.version ? ` · version ${row.deck.version}` : ""}
                            {row.aiGenerated ? " · AI label" : ""}
                          </span>
                        </div>
                      </div>
                    </TD>
                    <TD className="max-w-[260px] align-top">
                      {row.caption ? <span className="line-clamp-2 whitespace-pre-line break-words text-[13px]">{row.caption}</span> : <span className="text-admin-subtle">{row.mediaType === "STORIES" ? "A story has none" : "None"}</span>}
                    </TD>
                    <TD className="max-w-[260px] align-top">
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={tone.tone}>{tone.label}</Badge>
                        {row.error && <span className="break-words text-xs text-admin-subtle">{row.error}</span>}
                      </div>
                    </TD>
                    <TD className="align-top text-xs">
                      <div className="flex flex-col">
                        <span>{row.approvedByName ?? "—"}</span>
                        {row.createdByName && row.createdByName !== row.approvedByName && <span className="text-admin-subtle">for {row.createdByName}</span>}
                        {row.proposalUrl ? (
                          <Link href={row.proposalUrl} className="text-admin-subtle underline-offset-2 hover:underline">
                            Jack&apos;s card
                          </Link>
                        ) : (
                          <span className="text-admin-subtle">Deck page</span>
                        )}
                      </div>
                    </TD>
                    <TD className="align-top">
                      {row.permalink ? (
                        <PartLink url={row.permalink}>Open</PartLink>
                      ) : row.status === "queued" || row.status === "containers" || row.status === "publishing" ? (
                        <CheckPublishButton id={row.id} />
                      ) : (
                        <span className="text-admin-subtle">—</span>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="Nothing posted from the site yet" description="Posts officers approve from a deck show up here, with how each went." className="py-6" />
        )}
      </PanelBody>
    </Panel>
  )
}

/** Instagram page sections from the decks-rooms track */
export const SECTIONS: InstagramSection[] = [{ id: "publishing", order: 20, Section: PublishingSection }]
