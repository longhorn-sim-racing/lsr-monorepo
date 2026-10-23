import { prisma } from "@/server/db"
import { departmentName } from "@/schemas/officer-profile.schema"

/**
 * Who's asking (design §8): how an officer's message reads to Jack, e.g.
 * "Gray (Technology Director · Technology · CS) [@gray-marshall]". Saved on the message when it's
 * posted (JackMessage.authorLabel) and never changed, so past turns read the same after a profile
 * changes (and stay a cached prefix). Jack matches his vocabulary to it; the facts never change with it.
 */

export type AuthorProfile = {
  displayName: string
  handle: string | null
  officerTitle: string | null
  /** The roster's team id ("technology"); shown by name */
  department: string | null
  major: string | null
}

/** Each part of the profile, at most; the whole label stays a line */
const PART_CHARS = 48
const NAME_CHARS = 60

/** One line: no line breaks or other control characters (a name can't start a second officer's line), clipped */
function clean(text: string | null | undefined, max: number): string {
  // eslint-disable-next-line no-control-regex
  const line = (text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** "Gray (Technology Director · Technology · CS) [@gray-marshall]"; parts that are missing are left out */
export function authorLabel(profile: AuthorProfile): string {
  const name = clean(profile.displayName, NAME_CHARS) || "Officer"
  const parts = [profile.officerTitle, departmentName(profile.department), profile.major].map((part) => clean(part, PART_CHARS)).filter(Boolean)
  const handle = clean(profile.handle, PART_CHARS).replace(/^@/, "")
  return `${name}${parts.length ? ` (${parts.join(" · ")})` : ""}${handle ? ` [@${handle}]` : ""}`
}

/** The label for an officer's message, from their profile as it is now; null when there's no such user */
export async function officerAuthorLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true, handle: true, officerTitle: true, department: true, major: true },
  })
  return user ? authorLabel(user) : null
}
