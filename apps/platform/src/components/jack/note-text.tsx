import { noteLink } from "@/lib/jack/proposals"
import { PartLink } from "./parts/part-link"

/**
 * A room note's text (#188). A note that ends with a site path ("Dylan applied: Edit the page … →
 * /admin/pages/…", from noteWithLink) links it as "open"; Jack's history keeps the path itself.
 * Anything else is plain text.
 */
export function NoteText({ text }: { text: string }) {
  const link = noteLink(text)
  if (!link) return <>{text}</>
  return (
    <>
      {link.text} →{" "}
      <PartLink url={link.path} className="text-xs">
        open
      </PartLink>
    </>
  )
}
