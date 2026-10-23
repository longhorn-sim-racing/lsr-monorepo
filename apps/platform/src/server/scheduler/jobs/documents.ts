import type { JobKind } from "../types"

/** Scheduled job kinds from the documents track (design §6). The registry joins every track's jobs in a fixed order */
export const JOBS: JobKind[] = []
