/**
 * An in-memory stand-in for the two scheduler tables, for the dispatcher's tests. It understands just the
 * filters the dispatcher uses (equality, null, lt/lte, OR) and applies each updateMany atomically, as
 * Postgres does for one UPDATE … WHERE: two claims for the same job can't both match.
 */

type Row = Record<string, unknown>

export type FakeJob = {
  id: string
  key: string
  kind: string
  schedule: string
  enabled: boolean
  config: unknown
  nextRunAt: Date
  lockedUntil: Date | null
  lastRunAt: Date | null
  lastStatus: string | null
  lastError: string | null
}

export type FakeRun = {
  id: string
  jobId: string
  startedAt: Date
  finishedAt: Date | null
  status: string
  summary: string | null
  error: string | null
}

const value = (v: unknown) => (v instanceof Date ? v.getTime() : v)

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Row[]).some((branch) => matches(row, branch))
    const actual = row[field]
    if (condition === null) return actual === null || actual === undefined
    if (condition instanceof Date || typeof condition !== "object") return value(actual) === value(condition)
    const ops = condition as Record<string, unknown>
    if ("lte" in ops && !(actual != null && (value(actual) as number) <= (value(ops.lte) as number))) return false
    if ("lt" in ops && !(actual != null && (value(actual) as number) < (value(ops.lt) as number))) return false
    if ("not" in ops && value(actual) === value(ops.not)) return false
    if ("in" in ops && !(ops.in as unknown[]).includes(actual)) return false
    return true
  })
}

function pick<T extends Row>(row: T, select?: Record<string, boolean>): Row {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
}

/** Yields like a database round trip would, so concurrent callers interleave (a microtask, so fake timers don't hold it up) */
const tick = () => Promise.resolve()

export function createFakeDb() {
  const jobs: FakeJob[] = []
  const runs: FakeRun[] = []
  let nextId = 1

  const db = {
    scheduledJob: {
      findMany: async ({ where, orderBy, take, select }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number; select?: Record<string, boolean> } = {}) => {
        await tick()
        let found = jobs.filter((job) => matches(job, where))
        if (orderBy?.nextRunAt) found = [...found].sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
        return found.slice(0, take ?? found.length).map((job) => pick(job, select))
      },
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        await tick()
        const job = jobs.find((row) => row.id === where.id)
        return job ? pick(job, select) : null
      },
      count: async ({ where }: { where?: Row } = {}) => {
        await tick()
        return jobs.filter((job) => matches(job, where)).length
      },
      updateMany: async ({ where, data }: { where: Row; data: Partial<FakeJob> }) => {
        await tick()
        const hit = jobs.filter((job) => matches(job, where))
        for (const job of hit) Object.assign(job, data)
        return { count: hit.length }
      },
    },
    scheduledJobRun: {
      create: async ({ data, select }: { data: Partial<FakeRun>; select?: Record<string, boolean> }) => {
        await tick()
        const run: FakeRun = { id: `run-${nextId++}`, jobId: "", startedAt: new Date(), finishedAt: null, status: "running", summary: null, error: null, ...data } as FakeRun
        runs.push(run)
        return pick(run, select)
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeRun> }) => {
        await tick()
        const run = runs.find((row) => row.id === where.id)
        if (!run) throw new Error(`No run ${where.id}`)
        Object.assign(run, data)
        return { ...run }
      },
      updateMany: async ({ where, data }: { where: Row; data: Partial<FakeRun> }) => {
        await tick()
        const hit = runs.filter((run) => matches(run, where))
        for (const run of hit) Object.assign(run, data)
        return { count: hit.length }
      },
      findFirst: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
        await tick()
        const run = runs.find((row) => matches(row, where))
        return run ? pick(run, select) : null
      },
    },
  }

  function addJob(job: Partial<FakeJob> & Pick<FakeJob, "kind">): FakeJob {
    const row: FakeJob = {
      id: `job-${nextId++}`,
      key: job.kind,
      schedule: "* * * * *",
      enabled: true,
      config: null,
      nextRunAt: new Date(0),
      lockedUntil: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      ...job,
    }
    jobs.push(row)
    return row
  }

  function addRun(run: Partial<FakeRun> & Pick<FakeRun, "jobId">): FakeRun {
    const row: FakeRun = { id: `run-${nextId++}`, startedAt: new Date(0), finishedAt: null, status: "running", summary: null, error: null, ...run }
    runs.push(row)
    return row
  }

  return { db, jobs, runs, addJob, addRun }
}
