"use client"

import { useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Download, MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { Badge, Button, DetailList, Notice, PageHeader, Panel, PanelBody, PanelHeader, SplitLayout, useConfirm } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { deckExportUrl, deckPageUrl, JACK_DECK_SIZES, slideImageUrl, type JackDeckSizeKey } from "@/lib/jack/decks"
import { formatUsd } from "@/lib/jack/spend"
import { cn } from "@/lib/utils"
import { restoreJackDeckVersion } from "../actions"

export type DeckPageData = {
  id: string
  title: string
  size: JackDeckSizeKey
  sizeLabel: string
  /** The version shown */
  version: number
  currentVersion: number
  slides: { id: string; notes: string | null }[]
  createdAt: string
  updatedAt: string
  createdByName: string | null
  room: { id: string; title: string } | null
  costUsd: number | null
}

export type DeckVersionRow = { version: number; summary: string; slides: number; createdAt: string; byName: string | null }

const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const formatWhen = (iso: string) => `${when.format(new Date(iso))} CT`

/**
 * A deck's page (#177): each slide large with its notes and a PNG download, the deck's details, and its
 * versions, any of which can be viewed or restored. Changes to the slides go through Jack in the room.
 */
export function JackDeckClient({ deck, versions }: { deck: DeckPageData; versions: DeckVersionRow[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [restoring, startRestore] = useTransition()
  const { width, height } = JACK_DECK_SIZES[deck.size]
  const portrait = height > width
  const old = deck.version !== deck.currentVersion

  function restore(version: number) {
    startRestore(async () => {
      const ok = await confirm({
        title: `Restore version ${version}?`,
        description: "It becomes the newest version. Nothing is lost: the versions after it stay in the history.",
        confirmLabel: "Restore",
      })
      if (!ok) return
      try {
        const result = await restoreJackDeckVersion(deck.id, version)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(`Restored version ${version}`)
        router.push(deckPageUrl(deck.id))
        router.refresh()
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't restore that version"))
      }
    })
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={deck.title}
        back={{ href: "/admin/jack/decks", label: "Decks and graphics" }}
        description={`${deck.sizeLabel} · ${deck.slides.length === 1 ? "1 slide" : `${deck.slides.length} slides`} · version ${deck.version}`}
        actions={
          <>
            {deck.slides.length > 0 && (
              <div className="flex items-center gap-1" role="group" aria-label="Download the whole deck">
                <span className="mr-1 text-xs text-admin-subtle">Download</span>
                {(
                  [
                    ["pdf", "PDF", "Every slide, with real text"],
                    ["pptx", "PPTX", "For Google Slides or PowerPoint; each slide is a picture, with the notes"],
                    ["zip", "PNGs", "Every slide as a full-size PNG, in a ZIP"],
                  ] as const
                ).map(([format, label, hint]) => (
                  <Button key={format} asChild size="sm" title={hint}>
                    <a href={deckExportUrl(deck.id, deck.version, format)}>
                      <Download aria-hidden />
                      {label}
                    </a>
                  </Button>
                ))}
              </div>
            )}
            {deck.room && (
              <Button asChild size="sm" variant="primary">
                <Link href={`/admin/jack/${deck.room.id}`}>
                  <MessageSquare aria-hidden />
                  Ask Jack for changes
                </Link>
              </Button>
            )}
          </>
        }
      />

      {old && (
        <Notice
          tone="info"
          className="mb-4"
          title={`You're looking at version ${deck.version}`}
          action={
            <div className="flex gap-2">
              <Button size="sm" asChild>
                <Link href={deckPageUrl(deck.id)}>See the current one</Link>
              </Button>
              <Button size="sm" variant="primary" pending={restoring} onClick={() => restore(deck.version)}>
                Restore this version
              </Button>
            </div>
          }
        >
          The deck is at version {deck.currentVersion}.
        </Notice>
      )}

      <SplitLayout
        main={
          <div className="flex flex-col gap-4">
            {deck.slides.length === 0 && (
              <Panel>
                <PanelBody>
                  <p className="text-[13px] text-muted-foreground">No slides yet. Ask Jack in the room to add some.</p>
                </PanelBody>
              </Panel>
            )}
            {deck.slides.map((slide, i) => (
              <Panel key={slide.id} id={`slide-${i + 1}`} className="scroll-mt-16">
                <PanelHeader
                  title={`Slide ${i + 1}`}
                  actions={
                    <Button asChild size="sm" variant="ghost">
                      <a href={slideImageUrl(deck.id, deck.version, slide.id, "png", { download: true })}>
                        <Download aria-hidden />
                        PNG
                      </a>
                    </Button>
                  }
                />
                <PanelBody className="flex flex-col gap-3">
                  <a
                    href={slideImageUrl(deck.id, deck.version, slide.id, "png")}
                    target="_blank"
                    rel="noreferrer"
                    className={cn("block overflow-hidden rounded-[4px] border bg-[#0B0B0B]", portrait && "mx-auto w-full max-w-sm")}
                    style={{ aspectRatio: `${width} / ${height}` }}
                    title="Open full size"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- an officer-only route renders it; next/image can't pass the session */}
                    <img src={slideImageUrl(deck.id, deck.version, slide.id, "view")} alt={`Slide ${i + 1}`} loading={i < 2 ? "eager" : "lazy"} className="size-full object-cover" />
                  </a>
                  {slide.notes && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-admin-subtle">Notes</span>
                      <p className="whitespace-pre-wrap text-[13px]">{slide.notes}</p>
                    </div>
                  )}
                </PanelBody>
              </Panel>
            ))}
          </div>
        }
        side={
          <div className="flex flex-col gap-4">
            <Panel>
              <PanelHeader title="Details" />
              <PanelBody>
                <DetailList
                  items={[
                    { label: "Size", value: `${deck.sizeLabel}, ${width}×${height}` },
                    { label: "Made in", value: deck.room ? <Link className="underline-offset-2 hover:underline" href={`/admin/jack/${deck.room.id}`}>{deck.room.title}</Link> : "A deleted room" },
                    { label: "For", value: deck.createdByName ?? "A former officer" },
                    { label: "Created", value: formatWhen(deck.createdAt) },
                    { label: "Updated", value: formatWhen(deck.updatedAt) },
                    ...(deck.costUsd !== null ? [{ label: "Jack's cost", value: <span title="What the replies that worked on this deck cost, data lookups included">{formatUsd(deck.costUsd)}</span> }] : []),
                  ]}
                />
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="Versions" description="Every change is kept. Restoring one makes it the newest." />
              <ol className="flex max-h-[520px] flex-col overflow-y-auto">
                {versions.map((row) => {
                  const shown = row.version === deck.version
                  const current = row.version === deck.currentVersion
                  return (
                    <li key={row.version} className={cn("flex items-start gap-2 border-b border-admin-row px-4 py-2.5 last:border-b-0", shown && "bg-admin-surface")}>
                      <span className="mt-px w-7 shrink-0 text-xs font-semibold tabular-nums text-admin-subtle">v{row.version}</span>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="break-words text-[13px]">{row.summary}</span>
                        <span className="text-xs text-admin-subtle">
                          {formatWhen(row.createdAt)}
                          {row.byName ? ` · for ${row.byName}` : ""} · {row.slides === 1 ? "1 slide" : `${row.slides} slides`}
                        </span>
                      </div>
                      {current ? (
                        <Badge tone="success">Current</Badge>
                      ) : (
                        <div className="flex shrink-0 gap-1">
                          {!shown && (
                            <Button asChild size="sm" variant="ghost">
                              <Link href={`${deckPageUrl(deck.id)}?v=${row.version}`}>View</Link>
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" disabled={restoring} onClick={() => restore(row.version)}>
                            Restore
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </Panel>
          </div>
        }
      />
    </div>
  )
}
