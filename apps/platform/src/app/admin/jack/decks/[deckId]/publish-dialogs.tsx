"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, ImagePlus, Send } from "lucide-react"
import { toast } from "sonner"
import { Badge, Button, CheckboxField, Dialog, Field, FieldGrid, Input, Notice, Segmented, Select, Textarea, useConfirm } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { slideImageUrl } from "@/lib/jack/decks"
import { CAROUSEL_MAX, CAROUSEL_MIN, defaultPublishType, PUBLISH_HISTORY, PUBLISH_STATUS, TYPE_LABEL, type DeckPublishOptions, type DeckRecentPost, type PublishType } from "@/lib/jack/publish"
import { cn } from "@/lib/utils"
import { addDeckToGallery, publishDeckToInstagram, readInstagramQuota } from "../publish-actions"

type Deck = { id: string; title: string; size: string; version: number; slides: { id: string }[] }

const HASHTAG = /#[\p{L}\p{N}_]+/gu
const TAG = /(?<![\w.@])@[A-Za-z0-9._]{1,30}/g

const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/** This deck's posts on their way or sent in the last day, so an officer sees what already went before posting */
function RecentPosts({ posts }: { posts: DeckRecentPost[] }) {
  if (!posts.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-admin-subtle">Sent from this deck lately</p>
      <ul className="flex flex-col rounded-md border bg-card text-sm">
        {posts.map((post) => (
          <li key={post.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-admin-row px-2.5 py-1.5 last:border-b-0">
            <span className="min-w-0 flex-1">
              {TYPE_LABEL[post.mediaType].replace(/^a /, "A ")}
              {post.mediaType === "CAROUSEL" ? ` of ${post.slides} slides` : ""}
              {post.version ? `, version ${post.version}` : ""} · {when.format(new Date(post.createdAt))} CT
            </span>
            <Badge tone={PUBLISH_STATUS[post.status].tone}>{PUBLISH_STATUS[post.status].label}</Badge>
            {post.permalink && (
              <a href={post.permalink} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
                Open
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Slides as a grid of thumbnails to tick; `single` makes it pick one */
function SlidePicker({ deck, picked, onChange, single, max }: { deck: Deck; picked: string[]; onChange: (ids: string[]) => void; single: boolean; max: number }) {
  const toggle = (id: string) => {
    if (single) return onChange([id])
    if (picked.includes(id)) return onChange(picked.filter((p) => p !== id))
    if (picked.length >= max) return
    // Keep the deck's order
    onChange(deck.slides.map((s) => s.id).filter((s) => s === id || picked.includes(s)))
  }
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" role={single ? "radiogroup" : "group"} aria-label="Slides">
      {deck.slides.map((slide, i) => {
        const on = picked.includes(slide.id)
        return (
          <li key={slide.id}>
            <button
              type="button"
              role={single ? "radio" : "checkbox"}
              aria-checked={on}
              onClick={() => toggle(slide.id)}
              className={cn("relative block w-full overflow-hidden rounded-[4px] border bg-[#0B0B0B] outline-none focus-visible:ring-2 focus-visible:ring-ring", on ? "border-primary ring-2 ring-primary" : "opacity-70 hover:opacity-100")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- an officer-only route; next/image can't pass the session */}
              <img src={slideImageUrl(deck.id, deck.version, slide.id, "thumb")} alt={`Slide ${i + 1}`} loading="lazy" className="aspect-square w-full object-contain" />
              <span className="absolute left-1 top-1 rounded bg-card px-1 text-xs font-semibold tabular-nums">{i + 1}</span>
              {on && <Check aria-hidden className="absolute right-1 top-1 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * "Publish to Instagram" on a deck page: the type, the slides, the caption (Jack's draft from the room
 * when there is one), alt text, the AI label, and the day's quota; then a confirm, and it posts
 */
export function PublishToInstagramDialog({ deck, options, open, onOpenChange }: { deck: Deck; options: DeckPublishOptions; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [type, setType] = useState<PublishType>(() => defaultPublishType(deck.size, deck.slides.length))
  const [picked, setPicked] = useState<string[]>(() => (type === "carousel" ? deck.slides.slice(0, CAROUSEL_MAX).map((s) => s.id) : deck.slides.slice(0, 1).map((s) => s.id)))
  const [caption, setCaption] = useState(options.captionDraft ?? "")
  const [altText, setAltText] = useState("")
  const [aiLabel, setAiLabel] = useState(false)
  const [quota, setQuota] = useState<{ used: number; total: number } | null | "loading" | "error">("loading")
  /** Why the last press was refused as already sent; cleared when the pick changes */
  const [repeat, setRepeat] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !options.instagram.ready) return
    let live = true
    readInstagramQuota()
      .then((result) => live && setQuota(result.ok ? (result.data ? { used: result.data.used, total: result.data.total } : null) : "error"))
      .catch(() => live && setQuota("error"))
    return () => {
      live = false
    }
  }, [open, options.instagram.ready])

  function changeType(next: PublishType) {
    setType(next)
    setRepeat(null)
    if (next !== "carousel") setPicked((current) => (current.length ? [current[0]] : deck.slides.slice(0, 1).map((s) => s.id)))
    else if (picked.length < CAROUSEL_MIN) setPicked(deck.slides.slice(0, CAROUSEL_MAX).map((s) => s.id))
  }

  const counts = useMemo(() => ({ characters: caption.length, hashtags: caption.match(HASHTAG)?.length ?? 0, tags: caption.match(TAG)?.length ?? 0 }), [caption])
  const captionTooLong = counts.characters > 2_200 || counts.hashtags > 30 || counts.tags > 20
  const countProblem = type === "carousel" && (picked.length < CAROUSEL_MIN || picked.length > CAROUSEL_MAX) ? `Pick ${CAROUSEL_MIN} to ${CAROUSEL_MAX} slides for a carousel.` : picked.length === 0 ? "Pick a slide." : null
  const quotaFull = quota !== null && typeof quota === "object" && quota.used >= quota.total
  const fit = type === "story" ? options.fit.story : options.fit.feed
  const blocked = !options.instagram.ready || Boolean(countProblem) || captionTooLong || quotaFull

  function pick(ids: string[]) {
    setPicked(ids)
    setRepeat(null)
  }

  // While it's posting the dialog stays open (Esc and clicks outside do nothing), so nobody presses Post again thinking it stopped
  function openChange(next: boolean) {
    if (!next && pending) return
    onOpenChange(next)
  }

  async function publish(again = false) {
    const what = type === "carousel" ? `a carousel of ${picked.length} slides` : type === "story" ? "a story" : "a post"
    const ok = await confirm(
      again
        ? { title: `Post ${what} again?`, description: `${repeat ?? "It was already sent."} Posting it again puts a second copy on Instagram.`, confirmLabel: "Post it again", tone: "danger" }
        : {
            title: `Post ${what} on Instagram now?`,
            description: `It goes up on ${options.instagram.account ? `@${options.instagram.account}` : "the club's account"} right away, in public, and can't be taken down from here (delete it in the Instagram app).`,
            confirmLabel: "Post it",
            tone: "danger",
          },
    )
    if (!ok) return
    start(async () => {
      try {
        const result = await publishDeckToInstagram({ deckId: deck.id, version: deck.version, slideIds: picked, type, caption: type === "story" ? "" : caption, altText: type === "post" ? altText : undefined, aiLabel, again })
        if (!result.ok) {
          if ("repeat" in result) {
            setRepeat(result.error)
            router.refresh()
          } else toast.error(result.error)
          return
        }
        if (result.data.state === "published") toast.success("It's up on Instagram")
        else toast.info("Sent. Instagram is still processing it; Content → Instagram shows when it's up.")
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't post it"))
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={openChange}
      size="lg"
      title="Publish to Instagram"
      description={`Version ${deck.version} of “${deck.title}”. Pressing Post it is the approval: it goes out right away.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void publish()} pending={pending} disabled={blocked || Boolean(repeat)}>
            <Send aria-hidden />
            Post…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!options.instagram.ready && (
          <Notice tone="warning" title="Instagram publishing isn't on">
            {options.instagram.problem ?? "An admin sets it up."}{" "}
            <Link href="/admin/connections" className="underline underline-offset-2">
              System → Connections
            </Link>
          </Notice>
        )}
        {repeat && (
          <Notice tone="warning" title="Already sent">
            {repeat}{" "}
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => void publish(true)} disabled={pending}>
              Post it again…
            </button>
          </Notice>
        )}
        <RecentPosts posts={options.recent} />
        <Field label="Post as">
          <Segmented
            label="Post as"
            value={type}
            onChange={changeType}
            options={[
              { value: "post", label: "Post (1 slide)" },
              { value: "carousel", label: `Carousel (${CAROUSEL_MIN}-${CAROUSEL_MAX})` },
              { value: "story", label: "Story (1 slide)" },
            ]}
          />
        </Field>
        <Field label={type === "carousel" ? `Slides (${picked.length} picked, in this order)` : "Slide"} error={countProblem ?? undefined} hint={fit ?? undefined}>
          <SlidePicker deck={deck} picked={picked} onChange={pick} single={type !== "carousel"} max={CAROUSEL_MAX} />
        </Field>
        {type !== "story" ? (
          <Field
            label="Caption"
            htmlFor="publish-caption"
            hint={`${counts.characters.toLocaleString("en-US")} of 2,200 characters · ${counts.hashtags} of 30 hashtags · ${counts.tags} of 20 tags${options.captionDraft ? " · started from Jack's caption draft in the room" : ""}`}
            error={captionTooLong ? "Instagram takes at most 2,200 characters, 30 hashtags and 20 @-tags." : undefined}
          >
            <Textarea id="publish-caption" rows={6} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="What the post says" />
          </Field>
        ) : (
          <p className="text-xs text-admin-subtle">Stories don&apos;t take a caption on Instagram: put the words on the slide.</p>
        )}
        {type === "post" && (
          <Field label="Alt text" htmlFor="publish-alt" hint="What the image shows, for people using screen readers (optional).">
            <Input id="publish-alt" value={altText} maxLength={1_000} onChange={(event) => setAltText(event.target.value)} />
          </Field>
        )}
        <CheckboxField
          label="Label it as made with AI"
          description="Instagram's AI label (is_ai_generated). Whether graphics Jack designed need it is still an open question for the board; leave it off unless you've been told to use it."
          checked={aiLabel}
          onChange={(event) => setAiLabel(event.target.checked)}
        />
        {options.instagram.ready && (
          <p className="text-xs text-admin-subtle">
            {quota === "loading"
              ? "Reading Instagram's daily limit…"
              : quota === "error"
                ? "Couldn't read Instagram's daily limit; posting checks it again."
                : quota
                  ? `Instagram API posts in the last 24 hours: ${quota.used} of ${quota.total}${quotaFull ? ". The limit is used up; try tomorrow." : "."}`
                  : null}{" "}
            Every post is listed on{" "}
            <Link href={PUBLISH_HISTORY} className="underline underline-offset-2">
              Content → Instagram
            </Link>
            .
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** "Add to gallery" on a deck page: the slides, the album (or a new one) and alt text; then a confirm */
export function AddToGalleryDialog({ deck, options, open, onOpenChange }: { deck: Deck; options: DeckPublishOptions; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [picked, setPicked] = useState<string[]>(() => deck.slides.map((s) => s.id))
  const [albumId, setAlbumId] = useState<string>(options.gallery.albums[0]?.id ?? "new")
  const [title, setTitle] = useState(deck.title)
  const [date, setDate] = useState("")
  const [alt, setAlt] = useState("")
  const isNew = albumId === "new"
  const albumTitle = isNew ? title.trim() : (options.gallery.albums.find((a) => a.id === albumId)?.title ?? "the album")
  const blocked = !options.gallery.ready || picked.length === 0 || (isNew && !title.trim())

  function openChange(next: boolean) {
    if (!next && pending) return
    onOpenChange(next)
  }

  async function add() {
    const ok = await confirm({
      title: `Add ${picked.length === 1 ? "1 slide" : `${picked.length} slides`} to “${albumTitle}”?`,
      description: "They show on the public gallery right away. Any can be taken off again on Gallery.",
      confirmLabel: "Add them",
    })
    if (!ok) return
    start(async () => {
      try {
        const result = await addDeckToGallery({
          deckId: deck.id,
          version: deck.version,
          slideIds: picked,
          album: isNew ? { kind: "new", title: title.trim(), date: date || null } : { kind: "existing", id: albumId },
          alt: alt.trim() || undefined,
        })
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(result.data.summary)
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't add them"))
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={openChange}
      size="lg"
      title="Add to gallery"
      description={`Slides of version ${deck.version} of “${deck.title}”, on the public gallery.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void add()} pending={pending} disabled={blocked}>
            <ImagePlus aria-hidden />
            Add…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!options.gallery.ready && (
          <Notice tone="warning" title="Cloudinary isn't set up on this server">
            Adding to the gallery needs CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET. Ask the Tech Team.
          </Notice>
        )}
        <Field label={`Slides (${picked.length} of ${deck.slides.length})`} error={picked.length === 0 ? "Pick at least one slide." : undefined}>
          <SlidePicker deck={deck} picked={picked} onChange={setPicked} single={false} max={deck.slides.length} />
        </Field>
        <FieldGrid>
          <Field label="Album" htmlFor="gallery-album">
            <Select id="gallery-album" value={albumId} onChange={(event) => setAlbumId(event.target.value)}>
              {options.gallery.albums.map((album) => (
                <option key={album.id} value={album.id}>
                  {album.title}
                </option>
              ))}
              <option value="new">New album…</option>
            </Select>
          </Field>
          <Field label="Alt text" htmlFor="gallery-alt" hint={`Default: “${deck.title}, slide N”`}>
            <Input id="gallery-alt" value={alt} maxLength={300} onChange={(event) => setAlt(event.target.value)} />
          </Field>
          {isNew && (
            <>
              <Field label="New album's title" htmlFor="gallery-title" required>
                <Input id="gallery-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field label="Date" htmlFor="gallery-date" hint="Albums sort by it (optional)">
                <Input id="gallery-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </Field>
            </>
          )}
        </FieldGrid>
      </div>
    </Dialog>
  )
}
