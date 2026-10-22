import Link from "next/link"
import { EmptyState, PageHeader, Panel } from "@/components/admin/kit"
import { deckPageUrl, JACK_DECK_SIZES, slideImageUrl } from "@/lib/jack/decks"
import { requireOfficerPage } from "@/server/auth/guards"
import { listDecks } from "@/server/jack/decks/service"

export const dynamic = "force-dynamic"

export const metadata = { title: "Decks and graphics · Jack" }

const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/** Every deck and graphic Jack has made (#177), newest first */
export default async function JackDecksPage() {
  await requireOfficerPage()
  const decks = await listDecks({ take: 200 })

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Decks and graphics"
        back={{ href: "/admin/jack", label: "Jack" }}
        description="Slides and Instagram graphics Jack made in the rooms. Ask him for changes in the room the deck came from."
      />
      {decks.length === 0 ? (
        <Panel>
          <EmptyState title="No decks yet" description="Ask Jack in a room for slides or a graphic, e.g. “make a 4-slide deck for GM 2” or “an Instagram story for recruiting”." />
        </Panel>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-4">
          {decks.map((deck) => {
            const { width, height, label } = JACK_DECK_SIZES[deck.size]
            return (
              <Link key={deck.id} href={deckPageUrl(deck.id)} className="group flex flex-col overflow-hidden rounded-lg border bg-card outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/40">
                <div className="relative bg-[#0B0B0B]" style={{ aspectRatio: "16 / 10" }}>
                  {deck.firstSlideId ? (
                    // eslint-disable-next-line @next/next/no-img-element -- an officer-only route renders it; next/image can't pass the session
                    <img
                      src={slideImageUrl(deck.id, deck.version, deck.firstSlideId, "thumb")}
                      alt=""
                      loading="lazy"
                      width={width}
                      height={height}
                      className="absolute inset-0 size-full object-contain"
                    />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-xs text-white/50">No slides yet</span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 border-t px-3 py-2.5">
                  <span className="truncate text-[13px] font-semibold group-hover:underline">{deck.title}</span>
                  <span className="text-xs text-admin-subtle">
                    {label} · {deck.slides === 1 ? "1 slide" : `${deck.slides} slides`}
                  </span>
                  <span className="truncate text-xs text-admin-subtle">
                    {when.format(deck.updatedAt)} CT{deck.roomTitle ? ` · ${deck.roomTitle}` : ""}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
