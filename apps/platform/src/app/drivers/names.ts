/** "Mark Yuan" → "MY", for drivers without a photo */
export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  )
}

/** Sorts names the same way on the server and in every visitor's browser */
export const byName = new Intl.Collator("en").compare
