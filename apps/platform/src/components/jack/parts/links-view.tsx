import type { JackLinksDisplay } from "@/lib/jack/parts"
import { PartLink } from "./part-link"

/** Links a tool found (#188): each title links to its page, outside ones with their host; then any meta and snippet */
export function LinksView({ display }: { display: JackLinksDisplay }) {
  if (!display.items.length) return display.caption ? <p className="text-xs text-admin-subtle">{display.caption}</p> : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ul className="flex flex-col rounded-lg border bg-card">
        {display.items.map((item, i) => (
          <li key={i} className="flex min-w-0 flex-col gap-0.5 border-b border-admin-row px-3 py-2 last:border-b-0">
            <span className="min-w-0 break-words">
              <PartLink url={item.url}>{item.title || item.url}</PartLink>
            </span>
            {item.meta && <span className="text-xs text-admin-subtle">{item.meta}</span>}
            {item.snippet && <p className="line-clamp-3 break-words text-xs text-muted-foreground">{item.snippet}</p>}
          </li>
        ))}
      </ul>
      {display.caption && <p className="text-xs text-admin-subtle">{display.caption}</p>}
    </div>
  )
}
