import { z } from "zod"
import { deckPageUrl, MAX_DECK_SLIDES } from "@/lib/jack/decks"
import type { MdPreviewBlock, MdPreviewInline } from "@/lib/jack/markdown-preview"
import { instagramPublishConnector } from "@/server/connectors/instagram/publish-connector"
import { getDeck } from "@/server/jack/decks/service"
import { captionCounts, captionProblem } from "@/server/jack/publish/caption"
import { CAROUSEL_MAX, CAROUSEL_MIN, fitNote, MEDIA_TYPE, PUBLISH_HISTORY, publishTargetId, TYPE_LABEL, type PublishType } from "@/lib/jack/publish"
import { describePublish, publishDeps, PublishRefused, SHAPE, startInstagramPublish } from "@/server/jack/publish/instagram"
import { pickSlides, slidesById, slidesLabel, slideThumbUrl } from "@/server/jack/publish/slides"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalKind, ProposalLink } from "../types"

/**
 * instagram.publish (design §4.3, §12.6): a deck version's slides posted to the club's Instagram as a
 * post (one slide), a carousel (2 to 20) or a story (one slide, no caption), with a caption and,
 * if an officer asks, Instagram's "made with AI" label. The card shows the slides and the caption;
 * applying asks first (it's public, and can't be taken back from here). The slides are pinned by id at
 * the version proposed, so what goes out is what the card showed. Applying needs Instagram publishing
 * switched on (System → Connections); the post goes through `startInstagramPublish`, whose
 * InstagramPublish row (one per proposal) makes sure it never goes out twice.
 */

export const instagramPublishSchema = z.object({
  deck: z.string().trim().min(1).max(64).describe("The deck's id (deck_view lists them)"),
  version: z.number().int().min(1).optional().describe("The deck version to post (default: its current one)"),
  slides: z.array(z.number().int().min(1).max(MAX_DECK_SLIDES)).min(1).max(CAROUSEL_MAX).optional().describe("Slide numbers, in posting order (default: every slide)"),
  type: z.enum(["post", "carousel", "story"]).describe("post: one slide in the feed; carousel: 2-20 slides as one feed post; story: one slide as a story (no caption)"),
  caption: z.string().trim().max(2_200).optional().describe("The caption, plain text, for a post or carousel: what an officer gave or approved (a caption you drafted with draft_text). Stories have none"),
  altText: z.string().trim().min(1).max(1_000).optional().describe("A description of the image for screen readers (single-image posts)"),
  aiLabel: z.boolean().optional().describe("Instagram's \"made with AI\" label (is_ai_generated). Only when an officer asks for it; the card shows the choice"),
})

export type InstagramPublishPayload = z.infer<typeof instagramPublishSchema>

const before = z.object({ deckId: z.string(), version: z.number().int(), slideIds: z.array(z.string()).min(1) })

/** The caption as the card shows it: its paragraphs as plain text */
function captionPreview(caption: string): MdPreviewBlock[] {
  return caption
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => ({ t: "p", c: para.split("\n").flatMap((line, i): MdPreviewInline[] => (i ? [{ t: "br" }, { t: "text", v: line }] : [{ t: "text", v: line }])) }))
}

/** Problems with the slides and fields for this type, written for Jack */
function typeProblem(p: InstagramPublishPayload, count: number): string | null {
  if (p.type === "post" && count !== 1) return `A post is one slide; this picks ${count}. Use type "carousel" for ${CAROUSEL_MIN}-${CAROUSEL_MAX} slides, or pick one slide.`
  if (p.type === "story" && count !== 1) return `A story is one slide; this picks ${count}. Propose one story per slide.`
  if (p.type === "carousel" && (count < CAROUSEL_MIN || count > CAROUSEL_MAX)) return `A carousel takes ${CAROUSEL_MIN} to ${CAROUSEL_MAX} slides; this picks ${count}.`
  if (p.type === "story" && p.caption) return "Stories don't take a caption on Instagram. Leave caption out (put the words on the slide), or post it to the feed."
  if (p.type !== "post" && p.altText) return "altText is for single-image posts only."
  return null
}

export const instagramPublishKind: ProposalKind<InstagramPublishPayload> = {
  kind: "instagram.publish",
  tool: "propose_deck_publish",
  description:
    "instagram.publish: post a deck's slides on the club's Instagram: one slide as a post, 2-20 as a carousel, or one as a story (no caption). Use the deck id and slide numbers from deck_view, and a caption the officer gave or approved; check the slides with deck_render first. The card shows the slides and caption, and an officer confirms before it goes out (it's public). aiLabel only when an officer asks.",
  schema: instagramPublishSchema,
  targetType: "INSTAGRAM_PUBLISH",
  permission: "officer",
  destructive: true,

  async prepare(p) {
    const picked = await pickSlides(p.deck, { version: p.version, numbers: p.slides })
    if ("error" in picked) throw new ProposalInputError(picked.error)
    const { deck, slides } = picked
    const problem = typeProblem(p, slides.length) ?? (p.caption ? captionProblem(p.caption) : null)
    if (problem) throw new ProposalInputError(problem)

    const type: PublishType = p.type
    const what = `${slidesLabel(slides)} of “${deck.title}” (version ${deck.version}) as ${TYPE_LABEL[MEDIA_TYPE[type]]}`
    const sentences = [`Applying it posts ${what} on the club's Instagram${type === "story" ? " (a story shows for 24 hours)" : ""}, right away and in public. It can't be taken down from here (delete it in the Instagram app).`]
    const fit = fitNote(deck.size, SHAPE[type])
    if (fit) sentences.push(fit)
    if (p.caption) {
      const { characters, hashtags, tags } = captionCounts(p.caption)
      sentences.push(`Caption: ${characters.toLocaleString("en-US")} characters, ${hashtags} hashtag${hashtags === 1 ? "" : "s"}${tags.length ? `, tagging ${tags.map((t) => `@${t}`).join(", ")}` : ""}.`)
    } else if (type !== "story") sentences.push("No caption.")
    sentences.push(p.aiLabel ? "It's marked on Instagram as made with AI." : "It isn't marked as made with AI.")

    // Whether it can go out now: switched on, and the day's quota (read live, never stored)
    const client = await instagramPublishConnector.client().catch(() => null)
    if (!client) sentences.push("Instagram publishing isn't switched on yet (System → Connections), so applying fails until an admin sets it up.")
    else {
      const quota = await client.quota().catch(() => null)
      if (quota) sentences.push(`Instagram's API posts in the last 24 hours: ${quota.used} of ${quota.total}.`)
    }

    const links: ProposalLink[] = [
      { title: "The deck", url: deckPageUrl(deck.id) },
      { title: "Publish history", url: PUBLISH_HISTORY },
    ]
    return {
      before: { deckId: deck.id, version: deck.version, slideIds: slides.map((s) => s.id) },
      // The post itself: a revised caption replaces this card, another type or other slides don't
      targetId: publishTargetId(deck.id, type, slides.map((s) => s.id)),
      view: {
        title: publishTitle(type, deck.title, slidesLabel(slides)),
        summary: sentences.join(" "),
        diff: [],
        images: slides.map((slide) => ({ url: slideThumbUrl(deck, slide.id), alt: `Slide ${slide.n} of “${deck.title}”`, label: `Slide ${slide.n}` })),
        ...(p.caption ? { preview: { label: "Caption", blocks: captionPreview(p.caption) } } : {}),
        links,
      },
    }
  },

  async checkStale(p, saved) {
    const pinned = before.safeParse(saved)
    if (!pinned.success) return "The proposal's slides are missing. Ask Jack to propose it again."
    if (!(await getDeck(pinned.data.deckId, pinned.data.version))) return "The deck was deleted since this was proposed."
    return null
  },

  async apply(p, ctx) {
    const pinned = before.safeParse(ctx.before)
    if (!pinned.success) throw new StaleProposalError("The proposal's slides are missing. Ask Jack to propose it again.")
    const picked = await slidesById(pinned.data.deckId, pinned.data.version, pinned.data.slideIds)
    if (!picked) throw new StaleProposalError("The deck or one of its slides was deleted since this was proposed.")
    const client = await instagramPublishConnector.client()
    if (!client) throw new Error("Instagram publishing isn't switched on (System → Connections), so nothing was posted. Ask an admin to set it up, then ask Jack again.")

    try {
      const outcome = await startInstagramPublish(
        {
          deck: picked.deck,
          slides: picked.slides,
          type: p.type,
          caption: p.caption ?? "",
          altText: p.altText,
          aiGenerated: p.aiLabel === true,
          proposalId: ctx.proposalId,
          createdById: ctx.auditMetadata.proposedFor ?? ctx.officer.userId,
          approvedById: ctx.officer.userId,
          auditMetadata: { ...ctx.auditMetadata },
        },
        publishDeps(client),
      )
      const { row } = outcome
      return {
        summary: describePublish(row, picked.deck.title),
        links: [...(row.permalink ? [{ title: "The post on Instagram", url: row.permalink }] : []), { title: "Publish history", url: PUBLISH_HISTORY }],
        created: [{ type: "INSTAGRAM_PUBLISH", id: row.id }],
        counts: { slides: row.slideIds.length },
      }
    } catch (error) {
      if (error instanceof PublishRefused) throw new Error(`${error.message} Nothing was posted.`)
      throw error
    }
  },
}

/** "Post slide 2 of “GM 2 recap” on Instagram", "Post “GM 2 recap” (slides 1-4) as an Instagram carousel" */
export function publishTitle(type: PublishType, title: string, slides: string): string {
  const text = type === "carousel" ? `Post “${title}” (${slides}) as an Instagram carousel` : type === "story" ? `Post ${slides} of “${title}” as an Instagram story` : `Post ${slides} of “${title}” on Instagram`
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}
