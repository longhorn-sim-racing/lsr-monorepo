/**
 * Matching names as officers write them ("Matt Gray", "@gray-marshall", "José", "J. Marshall") to
 * members, for check-ins (attendance.checkin). Pure, so it's tested on its own.
 *
 * - A handle (with or without "@") or an email matches exactly.
 * - Otherwise names compare word by word, ignoring case, accents and punctuation: the same words in any
 *   order; the same first name (nicknames count: Matt and Matthew, Alex and Alexander) and last name;
 *   an initial and a last name, or a first name and an initial; or a lone first or last name.
 * - The event's own list (registered and waitlisted people) is searched first: a name that fits one of
 *   them is theirs. Only then are all members searched, and there a lone name never counts as a match.
 */

export type NameCandidate = { id: string; displayName: string; handle: string; email?: string | null }

export type NameMatch<C extends NameCandidate> = { kind: "matched"; member: C } | { kind: "ambiguous"; candidates: C[] } | { kind: "unmatched" }

/** Most people an ambiguous name lists */
export const MAX_CANDIDATES = 5

/** First names that are the same person's (a nickname and the full name) */
const NICKNAME_GROUPS = [
  ["alex", "alexander", "alexandra", "alexis", "alejandro", "alec", "lex"],
  ["andy", "andrew", "drew", "andres"],
  ["abby", "abigail"],
  ["ben", "benjamin", "benny"],
  ["bill", "billy", "will", "willy", "william", "liam"],
  ["bob", "bobby", "rob", "robbie", "robert", "bert"],
  ["charlie", "charles", "chuck", "chaz"],
  ["chris", "christopher", "christina", "christine", "kris", "kristopher"],
  ["dan", "danny", "daniel"],
  ["dave", "davey", "david"],
  ["ed", "eddie", "edward", "ted", "teddy"],
  ["fred", "freddie", "frederick"],
  ["gabe", "gabriel", "gabby", "gabriela", "gabrielle"],
  ["greg", "gregory"],
  ["jake", "jacob"],
  ["jim", "jimmy", "jamie", "james"],
  ["jen", "jenny", "jennifer"],
  ["jess", "jessie", "jessica"],
  ["joe", "joey", "joseph", "jose"],
  ["john", "johnny", "jon", "jonathan", "jack"],
  ["josh", "joshua"],
  ["kate", "katie", "kathy", "katherine", "catherine", "kat", "cat"],
  ["ken", "kenny", "kenneth"],
  ["liz", "lizzie", "beth", "eliza", "elizabeth"],
  ["luke", "lucas"],
  ["matt", "matty", "matthew", "mateo"],
  ["max", "maxwell", "maximilian", "maxim"],
  ["meg", "maggie", "megan", "margaret"],
  ["mike", "mikey", "mick", "michael", "miguel"],
  ["nate", "nathan", "nathaniel"],
  ["nick", "nicky", "nico", "nicholas", "nicolas"],
  ["pat", "patrick", "patricia", "patty"],
  ["ray", "raymond"],
  ["rick", "ricky", "rich", "richard", "ricardo"],
  ["ron", "ronnie", "ronald"],
  ["sam", "sammy", "samuel", "samantha"],
  ["steve", "steven", "stephen"],
  ["sue", "susan", "suzanne"],
  ["tim", "timmy", "timothy"],
  ["tom", "tommy", "thomas", "tomas"],
  ["tony", "anthony", "antonio"],
  ["vic", "victor", "victoria", "vicky"],
  ["zach", "zack", "zachary"],
]

const GROUPS_OF = new Map<string, number[]>()
NICKNAME_GROUPS.forEach((group, i) => group.forEach((name) => GROUPS_OF.set(name, [...(GROUPS_OF.get(name) ?? []), i])))

/** Lowercase, no accents, apostrophes and periods dropped ("O'Brien" is "obrien"), other punctuation as spaces */
export function normalizeName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

export function nameTokens(text: string): string[] {
  return normalizeName(text).split(" ").filter(Boolean)
}

/** The same first name: equal, nicknames of each other, or one the start of the other (Chris, Christopher) */
export function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true
  const groups = GROUPS_OF.get(a)
  if (groups && GROUPS_OF.get(b)?.some((g) => groups.includes(g))) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 3 && long.startsWith(short)
}

const isInitial = (token: string) => token.length === 1

/** How well `query` names `member`: 4 handle or email, 3 the same name, 2.5 first and last name, 2 an initial with a name, 1 a lone name, 0 not them */
export function scoreName(query: string, member: NameCandidate): number {
  const raw = query.trim()
  const lower = raw.toLowerCase()
  if (lower.includes("@") && lower.includes(".") && !lower.startsWith("@")) return member.email && member.email.toLowerCase() === lower ? 4 : 0
  if (/^@?[a-z0-9_-]+$/i.test(raw) && member.handle.toLowerCase() === lower.replace(/^@/, "")) return 4
  if (raw.startsWith("@")) return 0

  const q = nameTokens(raw)
  const m = nameTokens(member.displayName)
  if (!q.length || !m.length) return 0
  if (q.join(" ") === m.join(" ") || (q.length === m.length && [...q].sort().join(" ") === [...m].sort().join(" "))) return 3
  const [qFirst, qLast] = [q[0], q[q.length - 1]]
  const [mFirst, mLast] = [m[0], m[m.length - 1]]
  if (q.length >= 2 && m.length >= 2) {
    if (!isInitial(qFirst) && !isInitial(qLast) && sameFirstName(qFirst, mFirst) && qLast === mLast) return 2.5
    // "J Marshall", "Gray M"
    if (isInitial(qFirst) && qFirst === mFirst[0] && qLast === mLast) return 2
    if (isInitial(qLast) && qLast === mLast[0] && sameFirstName(qFirst, mFirst)) return 2
    return 0
  }
  if (q.length === 1 && !isInitial(qFirst)) return sameFirstName(qFirst, mFirst) || qFirst === mLast ? 1 : 0
  return 0
}

function best<C extends NameCandidate>(query: string, pool: C[]): { score: number; members: C[] } {
  let top = 0
  let members: C[] = []
  for (const member of pool) {
    const score = scoreName(query, member)
    if (score > top) {
      top = score
      members = [member]
    } else if (score > 0 && score === top) members.push(member)
  }
  return { score: top, members }
}

/**
 * Who a written name is: one member, a few it could be, or nobody. `list` is the event's own list
 * (searched first), `everyone` every member (the list's people included)
 */
export function matchName<C extends NameCandidate>(query: string, list: C[], everyone: C[]): NameMatch<C> {
  const onList = best(query, list)
  if (onList.score > 0) {
    if (onList.members.length === 1) return { kind: "matched", member: onList.members[0] }
    return { kind: "ambiguous", candidates: onList.members.slice(0, MAX_CANDIDATES) }
  }
  const all = best(query, everyone)
  if (all.score >= 2 && all.members.length === 1) return { kind: "matched", member: all.members[0] }
  // A lone name, or a name several members share: offer them, unless it's too common to be useful
  if (all.score > 0 && all.members.length <= MAX_CANDIDATES) return { kind: "ambiguous", candidates: all.members }
  return { kind: "unmatched" }
}
