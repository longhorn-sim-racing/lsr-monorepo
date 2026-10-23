import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { Badge, DetailList, Notice, PageHeader, Panel, PanelBody, PanelHeader, SplitLayout } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { describeAge, knowledgeAge, knowledgeEntryPath, roomMessagePath } from "@/lib/jack/knowledge"
import { partLink } from "@/lib/jack/links"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { getKnowledgeEntryDetail, listKnowledgeOwners, type KnowledgePerson } from "@/server/jack/knowledge/queries"
import { EntryActions, RestoreVersionButton } from "../_components/entry-actions"
import { KnowledgeForm } from "../_components/knowledge-form"
import { AgeBadge, EntryStatus, SOURCE_LABEL, VIA_LABEL } from "../_components/labels"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Knowledge entry" }

const when = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, yyyy, h:mm a")
const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, yyyy")

/** A name for a user id on the entry: the account's name, "Former officer" once it's gone, or "a script" for none */
function who(person: KnowledgePerson | null): string {
  if (!person) return "a script"
  return person.name ?? "Former officer"
}

export default async function KnowledgeEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireOfficerPage()
  const [{ id }, query, session] = await Promise.all([params, searchParams, getCachedSessionUser()])
  const [detail, owners] = await Promise.all([getKnowledgeEntryDetail(id), listKnowledgeOwners()])
  if (!detail) notFound()

  const { entry, versions, latestVersionId, provenance } = detail
  const now = new Date()
  const age = knowledgeAge(entry, now)
  const versionParam = Array.isArray(query.version) ? query.version[0] : query.version
  const viewing = versionParam && versionParam !== latestVersionId ? versions.find((v) => v.id === versionParam) : undefined
  const sourceLink = entry.sourceUrl ? partLink(entry.sourceUrl) : null
  const isAdmin = session.roles.includes("admin")

  return (
    <>
      <PageHeader
        back={{ href: "/admin/knowledge", label: "Knowledge" }}
        title={entry.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <EntryStatus unreviewed={detail.unreviewed} archived={!!entry.archivedAt} />
            <AgeBadge age={age} />
            <span>{describeAge(age)}</span>
          </span>
        }
        actions={<EntryActions id={entry.id} title={entry.title} archived={!!entry.archivedAt} canDelete={isAdmin} baseVersionId={latestVersionId} />}
      />

      <SplitLayout
        main={
          <div className="flex flex-col gap-4">
            {entry.archivedAt && (
              <Notice title={`Archived ${day(entry.archivedAt)}`}>Jack doesn&apos;t find archived entries. Unarchive it to bring it back; you can still edit it here.</Notice>
            )}
            {detail.unreviewed && !entry.archivedAt && (
              <Notice tone="warning" title="Saved or changed by Jack, not reviewed yet">
                Check it&apos;s right (and still true), fix anything that isn&apos;t, then mark it reviewed.
              </Notice>
            )}
            {viewing && (
              <Panel>
                <PanelHeader
                  title={`Version from ${when(viewing.createdAt)}`}
                  description={`By ${who(viewing.editedBy)} · ${VIA_LABEL[viewing.via] ?? viewing.via}`}
                  actions={<RestoreVersionButton entryId={entry.id} versionId={viewing.id} baseVersionId={latestVersionId} label={when(viewing.createdAt)} />}
                />
                <PanelBody className="flex flex-col gap-2">
                  <p className="text-sm font-semibold">{viewing.title}</p>
                  {viewing.tags.length > 0 && <p className="text-xs text-admin-subtle">{viewing.tags.join(" · ")}</p>}
                  <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-admin-surface p-3 font-mono text-xs leading-relaxed">{viewing.body}</pre>
                  <Link href={knowledgeEntryPath(entry.id)} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                    Back to the current version
                  </Link>
                </PanelBody>
              </Panel>
            )}
            <KnowledgeForm
              // A fresh form for every new version, so a save is always based on the text it shows
              key={latestVersionId ?? entry.id}
              id={entry.id}
              baseVersionId={latestVersionId}
              reviewed={!!entry.reviewedAt && !age.stale}
              owners={owners.some((o) => o.id === entry.ownerId) || !entry.owner ? owners : [...owners, { id: entry.owner.id, displayName: entry.owner.displayName, handle: entry.owner.handle }]}
              initial={{
                title: entry.title,
                body: entry.body,
                tags: entry.tags.join(", "),
                sourceNote: entry.sourceNote ?? "",
                sourceUrl: entry.sourceUrl ?? "",
                sourceDate: entry.sourceDate ? formatInTimeZone(entry.sourceDate, DEFAULT_TIMEZONE, "yyyy-MM-dd") : "",
                ownerId: entry.ownerId ?? "",
              }}
            />
          </div>
        }
        side={
          <div className="flex flex-col gap-4">
            <Panel>
              <PanelHeader title="Details" />
              <PanelBody>
                <DetailList
                  items={[
                    { label: "Source", value: SOURCE_LABEL[entry.sourceType] },
                    {
                      label: "From",
                      value: (
                        <span className="flex flex-col gap-0.5">
                          <span>{entry.sourceNote ?? <span className="text-admin-subtle">No note</span>}</span>
                          {entry.sourceDate && <span className="text-xs text-admin-subtle">Dated {day(entry.sourceDate)}</span>}
                          {sourceLink && (
                            <a href={sourceLink.href} target={sourceLink.internal ? undefined : "_blank"} rel="noreferrer" className="break-all text-xs font-medium hover:underline">
                              {sourceLink.internal ? sourceLink.href : sourceLink.host}
                            </a>
                          )}
                        </span>
                      ),
                    },
                    {
                      label: "Reviewed",
                      value: entry.reviewedAt ? `${day(entry.reviewedAt)} by ${who(detail.reviewedBy)}` : <span className="text-admin-subtle">Not yet</span>,
                    },
                    { label: "Owner", value: entry.owner?.displayName ?? <span className="text-admin-subtle">No owner</span> },
                    { label: "Created", value: `${day(entry.createdAt)} by ${who(detail.createdBy)}` },
                    { label: "Last change", value: `${day(entry.updatedAt)} by ${who(detail.updatedBy)}` },
                  ]}
                />
              </PanelBody>
            </Panel>

            {provenance && (
              <Panel>
                <PanelHeader title="Where Jack got it" description="The reply behind Jack's latest save or change" />
                <PanelBody className="flex flex-col gap-2 text-[13px]">
                  <p>
                    Asked by {detail.askedBy ? who(detail.askedBy) : "an officer"},{" "}
                    <Link href={roomMessagePath(provenance.roomId, provenance.messageIds[0] ?? provenance.replyId)} className="font-medium hover:underline">
                      in {detail.roomTitles[provenance.roomId] ?? "a Jack room"}
                    </Link>
                    , {day(new Date(provenance.at))}.
                  </p>
                  {provenance.tools.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-xs text-admin-subtle">Tools the reply used first (outside sources show here):</p>
                      <ul className="flex flex-col gap-1">
                        {provenance.tools.map((tool, i) => (
                          <li key={i} className="min-w-0 rounded-md border bg-admin-surface px-2 py-1.5 text-xs">
                            <span className="font-semibold">{tool.name}</span> · {tool.label}
                            <span className="block truncate font-mono text-[11px] text-admin-subtle" title={tool.input}>
                              {tool.input}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-xs text-admin-subtle">The reply used no other tools first: it came from the officers&apos; messages.</p>
                  )}
                </PanelBody>
              </Panel>
            )}

            <Panel>
              <PanelHeader title="History" description={`${versions.length} version${versions.length === 1 ? "" : "s"}, newest first`} />
              <ol className="flex flex-col">
                {versions.map((version) => {
                  const current = version.id === latestVersionId
                  return (
                    <li key={version.id} className="flex items-start justify-between gap-3 border-b border-admin-row px-4 py-2.5 text-[13px] last:border-b-0">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium">{when(version.createdAt)}</span>
                        <span className="text-xs text-admin-subtle">
                          {who(version.editedBy)} · {VIA_LABEL[version.via] ?? version.via}
                          {version.roomId && (
                            <>
                              {" · "}
                              <Link href={roomMessagePath(version.roomId)} className="hover:underline">
                                {detail.roomTitles[version.roomId] ?? "Jack room"}
                              </Link>
                            </>
                          )}
                        </span>
                      </span>
                      {current ? (
                        <Badge tone="success">Current</Badge>
                      ) : (
                        <Link href={`${knowledgeEntryPath(entry.id)}?version=${version.id}`} className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground">
                          {viewing?.id === version.id ? "Viewing" : "View"}
                        </Link>
                      )}
                    </li>
                  )
                })}
              </ol>
            </Panel>
          </div>
        }
      />
    </>
  )
}
