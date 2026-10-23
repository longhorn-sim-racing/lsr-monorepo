import { z } from "zod"
import type { JackTextDraftDisplay } from "@/lib/jack/parts"
import { prisma } from "@/server/db"
import { forModel } from "./display"
import type { JackTool, JackToolContext } from "./types"

/**
 * draft_text (#188, design §7.1): an email, an agenda, a caption or any other text, shown in the room as
 * a copyable draft (the text_draft card). It never sends anything: the officer copies it and sends it
 * themselves. Always loaded.
 *
 * Contact details in a draft must come from an officer: an email address or phone number has to appear
 * in something an officer typed in this room (or be one of the club's own addresses). Anything else is
 * refused, so a draft never carries a member's or a contact's details that Jack only read in club data.
 */

/** Instagram's caption limits: 2,200 characters and 30 hashtags */
export const CAPTION_MAX_CHARS = 2_200
export const CAPTION_MAX_HASHTAGS = 30
/** How many of the room's officer messages count as "what officers gave" */
const OFFICER_MESSAGES = 200
/** The club's own addresses, fine in any draft */
const CLUB_DOMAINS = ["longhornsimracing.org"]

const input = z.object({
  type: z.enum(["email", "agenda", "caption", "text"]).describe("email, a meeting agenda, an Instagram caption, or other text"),
  subject: z.string().trim().min(1).max(200).optional().describe("Emails: the subject line"),
  to: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Emails: who it\'s for, as the officer put it ("Jordan at Apex Sim Rigs"). An email address only if an officer gave it in this room'),
  body: z.string().trim().min(1).max(10_000).describe("The text, ready to send. Emails and captions: plain text, no Markdown"),
})

type Input = z.infer<typeof input>

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
/** A phone number: 3-3-4 digits with the usual separators, optionally after a country code. Dates and times don't fit it */
const PHONE = /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g

const digits = (text: string) => text.replace(/\D/g, "")

/** Email addresses and phone numbers in a text (lowercase addresses, phone numbers as digits) */
export function contactDetails(text: string): { emails: string[]; phones: string[] } {
  const emails = [...new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()))]
  const phones = [...new Set((text.match(PHONE) ?? []).map(digits).filter((d) => d.length >= 10 && d.length <= 15))]
  return { emails, phones }
}

/** The contact details in a draft that no officer gave: not in `officerText`, and not the club's own */
export function unsourcedDetails(draft: string, officerText: string): string[] {
  const given = contactDetails(officerText)
  const { emails, phones } = contactDetails(draft)
  return [
    ...emails.filter((email) => !given.emails.includes(email) && !CLUB_DOMAINS.some((domain) => email.endsWith(`@${domain}`))),
    ...phones.filter((phone) => !given.phones.some((g) => g.endsWith(phone) || phone.endsWith(g))),
  ]
}

/** What officers typed in this room: their own messages, newest first */
async function officerText(ctx: JackToolContext): Promise<string> {
  const rows = await prisma.jackMessage.findMany({
    where: { roomId: ctx.roomId, kind: "user" },
    orderBy: { createdAt: "desc" },
    take: OFFICER_MESSAGES,
    select: { content: true },
  })
  return rows.map((row) => row.content).join("\n")
}

const LABEL: Record<Input["type"], string> = { email: "an email", agenda: "an agenda", caption: "a caption", text: "a draft" }

export const draftTextTool: JackTool<Input> = {
  name: "draft_text",
  description:
    "Shows a draft in the room for an officer to copy and send themselves: an email (with subject and who it's for), a meeting agenda, an Instagram caption, or other text. It never sends anything. Use it whenever an officer asks you to draft or write something they'll send or post. Contact details (emails, phone numbers) only if an officer gave them in this room.",
  input,
  async run({ type, subject, to, body }, ctx) {
    if (type === "caption") {
      const hashtags = body.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0
      if (body.length > CAPTION_MAX_CHARS) return { isError: true, forModel: `Instagram captions hold at most ${CAPTION_MAX_CHARS.toLocaleString("en-US")} characters; this one has ${body.length.toLocaleString("en-US")}. Shorten it.`, label: "Draft too long", displays: [] }
      if (hashtags > CAPTION_MAX_HASHTAGS) return { isError: true, forModel: `Instagram allows at most ${CAPTION_MAX_HASHTAGS} hashtags; this caption has ${hashtags}.`, label: "Too many hashtags", displays: [] }
    }
    const unsourced = unsourcedDetails([subject, to, body].filter(Boolean).join("\n"), await officerText(ctx))
    if (unsourced.length) {
      return {
        isError: true,
        forModel: `The draft has contact details no officer gave in this room (${unsourced.join(", ")}). Leave them out (name the person instead, e.g. "Jordan at Apex"), and tell the officer where to find them if it helps (the prospect's page on Sponsors).`,
        label: "Draft not shown",
        displays: [],
      }
    }

    const display: JackTextDraftDisplay = { kind: "text_draft", draftKind: type, ...(type === "email" && subject ? { subject } : {}), ...(type === "email" && to ? { to } : {}), body }
    return {
      forModel: forModel({
        shown: true,
        type,
        characters: body.length,
        note: "The draft is in the room with a Copy button. Nothing was sent: the officer copies it and sends or posts it themselves. Don't repeat the draft in your reply; say in a sentence what it is and anything they should fill in or check.",
      }),
      label: `Drafted ${LABEL[type]}${type === "email" && to ? ` to ${to}` : ""}`,
      displays: [display],
    }
  },
}
