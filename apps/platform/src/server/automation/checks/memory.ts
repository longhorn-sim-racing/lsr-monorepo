import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { knowledgeAge, knowledgeEntryPath, formatAge } from "@/lib/jack/knowledge"
import { prisma } from "@/server/db"
import { knowledgeWhere } from "@/server/jack/knowledge/queries"
import type { DigestCheck } from "../types"

/** Entries each check lists; the count covers the rest */
const ITEMS = 5

/** Digest and Overview "needs attention" checks from the memory track (design §11.2) */
export const CHECKS: DigestCheck[] = [
  {
    id: "knowledge.unreviewed",
    label: "Knowledge Jack saved, not reviewed yet",
    href: "/admin/knowledge?view=unreviewed",
    order: 80,
    async run({ now }) {
      const where = knowledgeWhere("unreviewed", now)
      const [count, rows] = await Promise.all([
        prisma.knowledgeEntry.count({ where }),
        prisma.knowledgeEntry.findMany({ where, orderBy: { updatedAt: "asc" }, take: ITEMS, select: { id: true, title: true, updatedAt: true } }),
      ])
      return {
        count,
        // A week of waiting is fine; a pile that keeps growing isn't
        severity: rows.some((row) => now.getTime() - row.updatedAt.getTime() > 14 * 86_400_000) ? "warning" : "info",
        items: rows.map((row) => ({ title: row.title, href: knowledgeEntryPath(row.id), detail: `Changed ${formatInTimeZone(row.updatedAt, DEFAULT_TIMEZONE, "MMM d")}` })),
      }
    },
  },
  {
    id: "knowledge.stale",
    label: "Knowledge over 6 months old",
    href: "/admin/knowledge?view=stale",
    order: 81,
    async run({ now }) {
      const where = knowledgeWhere("stale", now)
      const [count, rows] = await Promise.all([
        prisma.knowledgeEntry.count({ where }),
        prisma.knowledgeEntry.findMany({ where, take: 200, select: { id: true, title: true, reviewedAt: true, sourceDate: true, updatedAt: true } }),
      ])
      const oldest = rows
        .map((row) => ({ row, age: knowledgeAge(row, now) }))
        .sort((a, b) => b.age.days - a.age.days)
        .slice(0, ITEMS)
      return {
        count,
        severity: "info",
        items: oldest.map(({ row, age }) => ({ title: row.title, href: knowledgeEntryPath(row.id), detail: `${formatAge(age.days)} old` })),
      }
    },
  },
]
