/**
 * A line diff for proposal cards (#188, design §4.1): what a page or post's text would become, as
 * removed and added lines with a little unchanged context around them. Pure, so the server and the
 * tests share it.
 *
 * The lines both texts share at the start and end are set aside first (an edit usually touches a few
 * lines of a long page), then the rest is matched with a longest-common-subsequence table. When what's
 * left is too big for the table, it shows as all of the old lines removed and all of the new ones added,
 * which is still correct, just less tidy.
 */

export type DiffLine = { op: "same" | "add" | "del"; text: string }

/** Unchanged lines left out of a hunk view, standing in for `count` lines */
export type DiffSkip = { op: "skip"; count: number }

export type DiffHunkLine = DiffLine | DiffSkip

/** Most cells of the matching table (rows × columns of the changed middle) before it gives up on tidiness */
const MAX_TABLE_CELLS = 2_000_000

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n")
}

/** Every line of both texts, in order, marked same, del or add */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const head = a.slice(0, start).map((text): DiffLine => ({ op: "same", text }))
  const tail = a.slice(endA).map((text): DiffLine => ({ op: "same", text }))
  return [...head, ...middle(a.slice(start, endA), b.slice(start, endB)), ...tail]
}

function middle(a: string[], b: string[]): DiffLine[] {
  if (!a.length) return b.map((text) => ({ op: "add", text }))
  if (!b.length) return a.map((text) => ({ op: "del", text }))
  if (a.length * b.length > MAX_TABLE_CELLS) return [...a.map((text): DiffLine => ({ op: "del", text })), ...b.map((text): DiffLine => ({ op: "add", text }))]

  // lcs[i][j]: the longest common run of a[i..] and b[j..], in one flat array
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ op: "del", text: a[i++] })
    } else {
      out.push({ op: "add", text: b[j++] })
    }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++] })
  while (j < b.length) out.push({ op: "add", text: b[j++] })
  return out
}

/** How many lines a diff adds and removes */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.op === "add") added++
    else if (line.op === "del") removed++
  }
  return { added, removed }
}

/**
 * The changed lines with `context` unchanged lines on each side; longer unchanged runs collapse into a
 * skip that says how many lines it stands for
 */
export function diffHunks(lines: DiffLine[], context = 2): DiffHunkLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.op === "same") return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true
  })
  const out: DiffHunkLine[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) out.push({ op: "skip", count: skipped })
      skipped = 0
      out.push(line)
    } else skipped++
  })
  if (skipped) out.push({ op: "skip", count: skipped })
  return out
}

/** "3 lines changed", "1 line added", "2 lines removed", or "No change" */
export function describeLineChanges({ added, removed }: { added: number; removed: number }): string {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`
  if (!added && !removed) return "No change"
  if (added && removed) {
    const changed = Math.min(added, removed)
    const rest = [added > changed ? `${added - changed} added` : null, removed > changed ? `${removed - changed} removed` : null].filter(Boolean)
    return `${lines(changed)} changed${rest.length ? `, ${rest.join(", ")}` : ""}`
  }
  return added ? `${lines(added)} added` : `${lines(removed)} removed`
}
