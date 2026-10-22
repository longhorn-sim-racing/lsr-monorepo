import Link from "next/link"
import { ArrowRight, Presentation } from "lucide-react"
import { Badge, Button } from "@/components/admin/kit"
import { deckPageUrl, JACK_DECK_SIZES, slideImageUrl } from "@/lib/jack/decks"
import type { JackDeckDisplay } from "@/lib/jack/parts"
import { cn } from "@/lib/utils"

/** Thumbnails the room shows per deck part; the deck page has the rest */
const MAX_THUMBS = 12

/**
 * A deck or graphic in a reply (#177): its title and size, its slides as thumbnails at the version
 * this call left it (the slides it wrote or looked at are outlined), and a link to the deck page.
 */
export function DeckCard({ display }: { display: JackDeckDisplay }) {
  const size = JACK_DECK_SIZES[display.size] ?? JACK_DECK_SIZES.slides
  const portrait = size.height > size.width
  const focus = new Set(display.focus ?? [])
  const shown = display.slideIds.slice(0, MAX_THUMBS)
  const href = deckPageUrl(display.deckId)
  const count = display.slideIds.length

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-admin-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Presentation aria-hidden className="size-4 shrink-0 text-admin-subtle" />
        <span className="min-w-0 break-words font-semibold">{display.title}</span>
        <Badge tone="neutral">{size.label}</Badge>
        <span className="text-xs text-admin-subtle">
          {count === 1 ? "1 slide" : `${count} slides`} · version {display.version}
        </span>
        <Button asChild size="sm" className="ml-auto">
          <Link href={href}>
            Open
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
      {shown.length > 0 && (
        <div className={cn("grid gap-2", portrait ? "grid-cols-[repeat(auto-fill,minmax(88px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]")}>
          {shown.map((id, i) => (
            <Link
              key={id}
              href={`${href}#slide-${i + 1}`}
              title={`Slide ${i + 1}`}
              className={cn(
                "relative overflow-hidden rounded-[3px] border bg-[#0B0B0B] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                focus.has(id) && "ring-2 ring-[#FF8000]"
              )}
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- an officer-only route renders it; next/image can't pass the session */}
              <img src={slideImageUrl(display.deckId, display.version, id, "thumb")} alt={`Slide ${i + 1}`} loading="lazy" className="size-full object-cover" />
              <span className="absolute bottom-1 left-1 rounded-sm bg-black/65 px-1 text-[10px] font-semibold tabular-nums text-white">{i + 1}</span>
            </Link>
          ))}
        </div>
      )}
      {count > shown.length && <p className="text-xs text-admin-subtle">{count - shown.length} more on the deck page.</p>}
    </div>
  )
}
