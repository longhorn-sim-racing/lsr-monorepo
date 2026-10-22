/**
 * Checks a rendered slide for the mistakes that are easy to miss (#177): text cut off at the edge or
 * inside a box, text running into other text, text below the size's minimum, fonts that aren't the
 * kit's, images that didn't load, and an empty slide. Jack gets these as plain text after every write,
 * so he can fix most layout problems without spending tokens looking at the image.
 *
 * `inspectSlide` runs inside the page (Puppeteer serializes it), so it must not use anything from
 * outside its own body. Page scripts are off; Puppeteer's own evaluation still runs.
 */

export type InspectOptions = { width: number; height: number; minFont: number }

/** Families the page loads; anything else falls back to Arial or the system's sans-serif */
const KIT_FONTS = ["kanit", "montserrat"]

export function inspectSlide(options: InspectOptions & { kitFonts: string[] }): string[] {
  const issues: string[] = []
  const snippet = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim()
    return `"${clean.length > 48 ? `${clean.slice(0, 47)}…` : clean}"`
  }

  type Run = { el: Element; text: string; rects: DOMRect[]; fontPx: number; family: string; weight: string; style: string }
  const runs: Run[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && runs.length < 400; node = walker.nextNode()) {
    const text = node.textContent ?? ""
    const el = node.parentElement
    if (!el || !text.trim() || el.closest("style")) continue
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
    if (!rects.length) continue
    const style = getComputedStyle(el)
    runs.push({
      el,
      text,
      rects,
      fontPx: parseFloat(style.fontSize),
      family: (style.fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, ""),
      weight: style.fontWeight,
      style: style.fontStyle,
    })
  }

  // Text cut off: by the slide's edge, or by a box with overflow hidden
  const clipped: string[] = []
  for (const run of runs) {
    let ancestor: Element | null = run.el
    let cut: { by: "edge" | "box"; px: number; side: string } | null = null
    while (ancestor && !cut) {
      const isPage = ancestor === document.body || ancestor === document.documentElement
      const style = getComputedStyle(ancestor)
      if (isPage || style.overflowX !== "visible" || style.overflowY !== "visible") {
        const box = isPage ? { left: 0, top: 0, right: options.width, bottom: options.height } : ancestor.getBoundingClientRect()
        for (const r of run.rects) {
          const over = [
            { side: "bottom", px: r.bottom - box.bottom },
            { side: "right", px: r.right - box.right },
            { side: "top", px: box.top - r.top },
            { side: "left", px: box.left - r.left },
          ].sort((a, b) => b.px - a.px)[0]
          if (over.px > 2) {
            const isSlideRoot = isPage || ancestor.parentElement === document.body
            cut = { by: isSlideRoot ? "edge" : "box", px: Math.round(over.px), side: over.side }
            break
          }
        }
      }
      ancestor = ancestor.parentElement
    }
    if (cut) {
      clipped.push(
        cut.by === "edge"
          ? `Text ${snippet(run.text)} runs ${cut.px}px past the ${cut.side} edge of the slide and is cut off.`
          : `Text ${snippet(run.text)} is cut off ${cut.px}px at the ${cut.side} of a box with overflow hidden.`
      )
    }
  }
  issues.push(...clipped.slice(0, 4))
  if (clipped.length > 4) issues.push(`${clipped.length - 4} more pieces of text are cut off.`)

  // The slide's content is taller (or wider) than the canvas
  for (const root of Array.from(document.body.children)) {
    const extraY = root.scrollHeight - root.clientHeight
    const extraX = root.scrollWidth - root.clientWidth
    if (root.clientHeight > 0 && extraY > 4) issues.push(`The content is ${extraY}px taller than the slide, so the bottom is cut off. Cut text or split the slide; don't shrink text below the minimum.`)
    if (root.clientWidth > 0 && extraX > 4) issues.push(`The content is ${extraX}px wider than the slide.`)
  }

  // Text running into other text (lines of different elements overlapping)
  const overlaps: string[] = []
  const seen = new Set<string>()
  outer: for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i]
      const b = runs[j]
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue
      for (const ra of a.rects) {
        for (const rb of b.rects) {
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
          if (w <= 0 || h <= 0) continue
          const smaller = Math.min(ra.width * ra.height, rb.width * rb.height)
          if ((w * h) / smaller < 0.25) continue
          const key = `${a.text}|${b.text}`
          if (!seen.has(key)) {
            seen.add(key)
            overlaps.push(`Text ${snippet(a.text)} overlaps ${snippet(b.text)}.`)
          }
          if (overlaps.length >= 3) break outer
          break
        }
      }
    }
  }
  issues.push(...overlaps)

  // Text below the minimum size
  const small = runs.filter((run) => run.fontPx + 0.5 < options.minFont)
  if (small.length) {
    const smallest = small.reduce((min, run) => (run.fontPx < min.fontPx ? run : min))
    issues.push(
      `${small.length === 1 ? "One piece of text is" : `${small.length} pieces of text are`} smaller than ${options.minFont}px (smallest: ${Math.round(smallest.fontPx)}px, ${snippet(smallest.text)}).`
    )
  }

  // Fonts: only the kit's load
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit"])
  const foreign = new Set<string>()
  const used = new Set<string>()
  for (const run of runs) {
    const family = run.family.toLowerCase()
    if (options.kitFonts.includes(family)) used.add(family)
    else if (!generic.has(family)) foreign.add(run.family)
  }
  for (const family of foreign) issues.push(`The font "${family}" isn't loaded, so it rendered as a fallback. Use Kanit or Montserrat.`)
  const faces = Array.from(document.fonts)
  for (const family of used) {
    const mine = faces.filter((face) => face.family.replace(/["']/g, "").toLowerCase() === family)
    if (mine.length && !mine.some((face) => face.status === "loaded")) issues.push(`The ${family === "kanit" ? "Kanit" : "Montserrat"} font didn't load in time, so this render used a fallback. Render again.`)
  }

  // Images that didn't load
  for (const img of Array.from(document.images)) {
    if (img.complete && img.naturalWidth === 0) issues.push(`An image didn't load: ${img.getAttribute("src") ?? "(no src)"}.`)
  }

  if (!runs.length && !document.images.length && !document.querySelector("svg")) issues.push("The slide is empty: no text or images.")
  return issues
}

export const INSPECT_KIT_FONTS = KIT_FONTS
