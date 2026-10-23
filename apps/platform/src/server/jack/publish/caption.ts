import { codePointLabel, hiddenCharacters } from "@/lib/jack/invisible"
import { parseToolParts } from "@/lib/jack/parts"
import { prisma } from "@/server/db"
import { CAPTION_MAX_CHARS, CAPTION_MAX_HASHTAGS } from "@/server/jack/tools/draft-text"

/**
 * Instagram captions (research/instagram.md §3d): at most 2,200 characters, 30 hashtags and 20 @-tags
 * (Instagram refuses more with 36004/2207010). And the caption Jack drafted in a room (draft_text's
 * caption card), which the deck page's Publish button starts from.
 */

export const CAPTION_MAX_TAGS = 20

const HASHTAG = /#[\p{L}\p{N}_]+/gu
const TAG = /(?<![\w.@])@([A-Za-z0-9._]{1,30})/g

export function captionCounts(caption: string): { characters: number; hashtags: number; tags: string[] } {
  return { characters: caption.length, hashtags: caption.match(HASHTAG)?.length ?? 0, tags: [...new Set([...caption.matchAll(TAG)].map((m) => m[1].toLowerCase()))] }
}

/** Why Instagram would refuse this caption, or null */
export function captionProblem(caption: string): string | null {
  const { characters, hashtags, tags } = captionCounts(caption)
  if (characters > CAPTION_MAX_CHARS) return `An Instagram caption holds at most ${CAPTION_MAX_CHARS.toLocaleString("en-US")} characters; this one has ${characters.toLocaleString("en-US")}.`
  if (hashtags > CAPTION_MAX_HASHTAGS) return `Instagram allows at most ${CAPTION_MAX_HASHTAGS} hashtags; this caption has ${hashtags}.`
  if (tags.length > CAPTION_MAX_TAGS) return `Instagram allows at most ${CAPTION_MAX_TAGS} @-tags; this caption has ${tags.length}.`
  return hiddenTextProblem("The caption", caption, { emoji: true })
}

/**
 * Why public text (`what`: "The caption", "The alt text") can't go out as it is: characters that draw as
 * nothing, so the officer approving it wouldn't see them (tag characters can spell a whole hidden
 * sentence). Null when every character shows. `emoji` as in `hiddenCharacters`
 */
export function hiddenTextProblem(what: string, text: string, { emoji = false }: { emoji?: boolean } = {}): string | null {
  const hidden = hiddenCharacters(text, { emoji })
  if (!hidden.length) return null
  const labels = [...new Set(hidden.map(codePointLabel))]
  const list = labels.length > 4 ? `${labels.slice(0, 4).join(", ")} and ${labels.length - 4} more` : labels.join(", ")
  const one = hidden.length === 1
  return `${what} has ${one ? "a character" : `${hidden.length} characters`} that ${one ? "doesn't" : "don't"} show on screen (${list}). Write it again without ${one ? "it" : "them"}: every character that's posted has to show where it's approved.`
}

/** How many replies back to look for a caption draft */
const REPLIES = 30

/** The newest caption Jack drafted in a room (draft_text, type caption), or null */
export async function latestCaptionDraft(roomId: string | null): Promise<string | null> {
  if (!roomId) return null
  const rows = await prisma.jackMessage.findMany({
    where: { roomId, kind: "assistant", toolCalls: { array_contains: [{ name: "draft_text" }] } },
    orderBy: { createdAt: "desc" },
    take: REPLIES,
    select: { toolCalls: true },
  })
  for (const row of rows) {
    const drafts = parseToolParts(row.toolCalls)
      .filter((part) => part.name === "draft_text" && part.status === "done")
      .flatMap((part) => part.displays ?? [])
      .filter((display) => display.kind === "text_draft" && display.draftKind === "caption")
    const newest = drafts.at(-1)
    if (newest && newest.kind === "text_draft") return newest.body
  }
  return null
}
