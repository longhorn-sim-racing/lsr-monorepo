import type { Season } from "@prisma/client"
import { equipmentLabel, leagueApplicationSchema, type LeagueApplicationInput } from "@/schemas/league-application.schema"
import { prisma } from "@/server/db"
import { DEFAULT_LEAGUE } from "@/server/jack/tools/seasons"
import { getOpenLeagueSeason, saveLeagueApplication } from "@/server/services/league-entry.service"
import type { ImportCells, ImportRowCheck, ImportTarget } from "../types"
import { plural, revalidate } from "./shared"

/**
 * The "LSC applications" import target (design §4.3): rows of a sheet (the old Google Form's responses,
 * a sign-up list) become Lone Star Cup entry forms (LeagueApplication) for a season, through the same
 * league-entry service the LSC entries page's "Add entrant" uses (saveLeagueApplication, source ADMIN).
 * As there, a driver needs a site account: each row is matched by email, then by UT EID. Rows for a
 * driver who already has an entry form for that season are left out (edit those on LSC entries), and
 * two rows for one driver are one entry form (the import marks the later one a repeat).
 */

type LscRow = { userId: string; seasonId: string; seasonName: string; input: LeagueApplicationInput }

/** UT EIDs look like 2–3 letters then digits (abc1234); anything else in the column isn't one */
const looksLikeEid = (value: string) => /^[a-z]{2,3}\d{2,5}$/i.test(value.trim())

const EXPERIENCE = ["NONE", "CASUAL", "SIM_RACER", "COMPETITIVE"] as const

/** The form's experience answer (its words, or the stored value) as the stored value; blank is "none yet" */
export function experienceFrom(answer: string): LeagueApplicationInput["experience"] {
  const a = answer.trim().toUpperCase().replace(/[\s-]+/g, "_")
  if ((EXPERIENCE as readonly string[]).includes(a)) return a as LeagueApplicationInput["experience"]
  const words = answer.toLowerCase()
  if (words.includes("competitive")) return "COMPETITIVE"
  if (words.includes("actively") || words.includes("sim racer")) return "SIM_RACER"
  if (words.includes("played") || words.includes("casual")) return "CASUAL"
  return "NONE"
}

/** Equipment named in an answer ("Steering wheel, Pedals") */
export function equipmentFrom(answer: string): LeagueApplicationInput["equipment"] {
  const a = answer.toLowerCase()
  const list: LeagueApplicationInput["equipment"] = []
  if (a.includes("wheel")) list.push("WHEEL")
  if (a.includes("pedal")) list.push("PEDALS")
  if (a.includes("controller") || a.includes("gamepad")) list.push("CONTROLLER")
  if (a.includes("keyboard")) list.push("KEYBOARD")
  return list
}

export function yes(answer: string): boolean {
  return /^(y|yes|true|1)\b/i.test(answer.trim()) || /\bbut yes\b/i.test(answer)
}

/** Blank or UT Austin means a UT student (the form leaves school blank for UT) */
export function isUt(school: string): boolean {
  return !school.trim() || /^(ut|ut austin|utexas|university of texas( at austin)?|the university of texas( at austin)?)$/i.test(school.trim())
}

/**
 * Seasons by what a row says (slug or name), looked up once per import's worth of rows. Old entries are
 * dropped, and so is a lookup that failed: the next row asks the database again
 */
const seasonCache = new Map<string, { at: number; season: Promise<Season | null> }>()
const SEASON_CACHE_MS = 30_000

function seasonFor(text: string): Promise<Season | null> {
  const key = text.trim().toLowerCase()
  const now = Date.now()
  for (const [cached, entry] of seasonCache) if (now - entry.at >= SEASON_CACHE_MS) seasonCache.delete(cached)
  const hit = seasonCache.get(key)
  if (hit) return hit.season
  const season = (async () => {
    const league = await prisma.league.findUnique({ where: { slug: DEFAULT_LEAGUE }, select: { id: true } })
    if (!league) return null
    if (!key) return getOpenLeagueSeason(league.id)
    return prisma.season.findFirst({ where: { leagueId: league.id, OR: [{ slug: { equals: key, mode: "insensitive" } }, { name: { equals: text.trim(), mode: "insensitive" } }] } })
  })()
  const entry = { at: now, season }
  seasonCache.set(key, entry)
  season.catch(() => {
    if (seasonCache.get(key) === entry) seasonCache.delete(key)
  })
  return season
}

async function findDriver(email: string, eid: string) {
  const select = { id: true, displayName: true, handle: true, eid: true, status: true } as const
  if (email) {
    const byEmail = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select })
    if (byEmail) return byEmail
  }
  return looksLikeEid(eid) ? prisma.user.findUnique({ where: { eid: eid.toLowerCase() }, select }) : null
}

export const lscApplicationTarget: ImportTarget<LscRow> = {
  target: "lsc_application",
  label: "LSC entry forms",
  columns: [
    { key: "email", label: "Email", description: "The driver's email, as on their site account (needed unless the EID finds them)" },
    { key: "eid", label: "UT EID", description: "Finds the account when the email doesn't; saved to it when it has none" },
    { key: "name", label: "Name", description: "Only shown on the card" },
    { key: "discord", label: "Discord username", required: true },
    { key: "experience", label: "Experience", description: "NONE, CASUAL, SIM_RACER, COMPETITIVE, or the form's answer" },
    { key: "equipment", label: "Equipment", required: true, description: "Wheel, pedals, controller and/or keyboard" },
    { key: "canCommit", label: "Can commit", description: "Yes or no" },
    { key: "school", label: "School", description: "Blank or UT Austin for UT students" },
    { key: "notes", label: "Notes" },
    { key: "season", label: "Season", description: "Season slug or name (default: the open Lone Star Cup season)" },
  ],

  async validateRow(row: ImportCells): Promise<ImportRowCheck<LscRow>> {
    const cell = (key: string) => (row[key] ?? "").trim()
    const email = cell("email")
    const eid = cell("eid")
    const label = cell("name") || email || eid || "A row with no name"
    if (!email && !eid) return { ok: false, label, error: "No email or UT EID to find their site account by." }

    const season = await seasonFor(cell("season"))
    if (!season) return { ok: false, label, error: cell("season") ? `No Lone Star Cup season “${cell("season")}”.` : "There's no open Lone Star Cup season to enter." }
    const user = await findDriver(email, eid)
    if (!user || user.status === "deleted") return { ok: false, label, error: "No site account has this email or UT EID: they need to sign up on the site first." }

    const existing = await prisma.leagueApplication.findUnique({ where: { userId_seasonId: { userId: user.id, seasonId: season.id } }, select: { source: true } })
    if (existing) return { ok: false, label, error: `${user.displayName} already has an entry form for ${season.name}; edit it on LSC entries.` }

    const equipment = equipmentFrom(cell("equipment"))
    if (!equipment.length) return { ok: false, label, error: "No equipment named (wheel, pedals, controller or keyboard)." }
    const school = cell("school")
    const ut = isUt(school)
    // An EID only goes on an account that has none, and only one nobody else holds
    let saveEid: string | undefined
    if (ut && looksLikeEid(eid) && !user.eid) {
      const holder = await prisma.user.findUnique({ where: { eid: eid.toLowerCase() }, select: { id: true } })
      if (!holder) saveEid = eid.toLowerCase()
    }
    const parsed = leagueApplicationSchema.safeParse({
      discordUsername: cell("discord"),
      experience: experienceFrom(cell("experience")),
      equipment,
      canCommit: yes(cell("canCommit")),
      utStudent: ut,
      ...(saveEid ? { eid: saveEid } : {}),
      ...(ut ? {} : { school }),
      notes: cell("notes") || undefined,
    })
    if (!parsed.success) return { ok: false, label, error: parsed.error.issues[0]?.message ?? "The row isn't a valid entry form." }

    const input = parsed.data
    return {
      ok: true,
      label,
      detail: `${user.displayName} (@${user.handle}) · ${season.name} · Discord ${input.discordUsername} · ${input.equipment.map(equipmentLabel).join(", ")}${ut ? "" : ` · ${school}`}`,
      status: "matched",
      key: `${user.id}:${season.id}`,
      value: { userId: user.id, seasonId: season.id, seasonName: season.name, input },
    }
  },

  async applyRows(rows, ctx) {
    const saved: string[] = []
    const problems: string[] = []
    const seasons = new Set<string>()
    for (const { rowId, value } of rows) {
      // Entered on the site (or by another officer) since the check: theirs stands
      const existing = await prisma.leagueApplication.findUnique({ where: { userId_seasonId: { userId: value.userId, seasonId: value.seasonId } }, select: { id: true } })
      if (existing) {
        problems.push(`a driver already had an entry form`)
        continue
      }
      try {
        await saveLeagueApplication({ userId: value.userId, seasonId: value.seasonId, input: value.input, actorUserId: ctx.officer.userId, source: "ADMIN", auditMetadata: ctx.auditMetadata })
        saved.push(rowId)
        seasons.add(value.seasonName)
      } catch (error) {
        problems.push((error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, ""))
      }
    }
    revalidate(["/admin/league-entries", "/lone-star-cup"])
    if (!saved.length) throw new Error(`No entry forms were added: ${problems.slice(0, 3).join("; ")}.`)
    const skipped = problems.length ? ` ${plural(problems.length, "row wasn't", "rows weren't")} added: ${[...new Set(problems)].slice(0, 3).join("; ")}.` : ""
    return {
      summary: `Added ${plural(saved.length, "LSC entry form")} (${[...seasons].join(", ")}).${skipped}`,
      links: [{ title: "LSC entries", url: "/admin/league-entries" }],
      appliedRows: saved,
      counts: { added: saved.length, skipped: problems.length },
    }
  },
}
