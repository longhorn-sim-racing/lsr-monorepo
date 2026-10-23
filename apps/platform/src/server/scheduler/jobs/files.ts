import { cleanupRoomFiles, sweepOrphanFiles } from "@/server/jack/files/cleanup"
import type { JobKind } from "../types"

/** Room file jobs (G5, design §5). Joined into the groundwork slot by the registry */
export const JOBS: JobKind[] = [
  {
    kind: "files.cleanup",
    label: "Room file cleanup",
    description:
      "Deletes files attached in Jack's rooms that were never sent: uploads still unfinished after 24 hours, and files not posted with a message after 7 days. Their stored copies go too, and any stored room file that no longer belongs to a file. Posted files are never touched.",
    defaultSchedule: "15 4 * * *",
    budgetMs: 60_000,
    async run({ signal, log }) {
      const result = await cleanupRoomFiles({ signal })
      if (result.objectErrors) throw new Error(`Removed ${result.deleted} files but couldn't delete ${result.objectErrors} of their stored copies; the next run's sweep retries them (see the function log).`)
      const swept = await sweepOrphanFiles({ signal })
      if (result.more || swept.more) log("More are due; the next run continues.")
      const done = [
        result.deleted ? `Deleted ${plural(result.deleted, "unsent file")} (${plural(result.objects, "stored copy", "stored copies")})` : "",
        swept.deleted ? `removed ${plural(swept.deleted, "leftover stored file")}` : "",
      ].filter(Boolean)
      return {
        summary: done.length ? capitalize(done.join("; ")) : "Nothing to clean up",
        counts: { files: result.deleted, objects: result.objects, leftovers: swept.deleted },
      }
    },
  },
]

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
