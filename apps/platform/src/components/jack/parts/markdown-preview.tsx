import { Fragment } from "react"
import { ImageIcon } from "lucide-react"
import type { JackProposalPreview, MdPreviewBlock, MdPreviewInline, MdPreviewListItem } from "@/lib/jack/markdown-preview"
import { cn } from "@/lib/utils"
import { PartLink } from "./part-link"

/**
 * A proposal's rendered preview (a news post, design §4.3): headings, paragraphs, lists, quotes, code
 * and tables, drawn as React elements from the tree the server parsed. Never HTML. Links show their
 * host; pictures aren't loaded, they show as a link with where they'd load from.
 */
export function MarkdownPreview({ preview }: { preview: JackProposalPreview }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-foreground">{preview.label}</span>
      <div className="max-h-[28rem] overflow-y-auto rounded-md border bg-card px-3 py-2.5">
        <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-headings:font-semibold prose-headings:tracking-normal prose-a:no-underline prose-code:before:content-none prose-code:after:content-none prose-pre:bg-muted prose-pre:text-foreground">
          {preview.title && <h1 className="!mb-2 !text-xl">{preview.title}</h1>}
          {preview.excerpt && <p className="!mt-0 text-muted-foreground">{preview.excerpt}</p>}
          <Blocks blocks={preview.blocks} />
        </div>
        {preview.truncated && <p className="mt-2 text-xs text-admin-subtle">The preview stops here; the whole text is in the change above.</p>}
      </div>
    </div>
  )
}

function Blocks({ blocks }: { blocks: MdPreviewBlock[] }) {
  return blocks.map((block, i) => <Block key={i} block={block} />)
}

function Block({ block }: { block: MdPreviewBlock }) {
  switch (block.t) {
    case "h": {
      const Tag = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[Math.min(Math.max(block.depth, 1), 6) - 1]
      return (
        <Tag>
          <Inlines nodes={block.c} />
        </Tag>
      )
    }
    case "p":
      return (
        <p>
          <Inlines nodes={block.c} />
        </p>
      )
    case "code":
      return (
        <pre>
          <code>{block.v}</code>
        </pre>
      )
    case "quote":
      return (
        <blockquote>
          <Blocks blocks={block.c} />
        </blockquote>
      )
    case "list": {
      const Tag = block.ordered ? "ol" : "ul"
      return (
        <Tag start={block.ordered && block.start !== undefined ? block.start : undefined}>
          {block.items.map((item, i) => (
            <ListItem key={i} item={item} />
          ))}
        </Tag>
      )
    }
    case "table":
      return (
        <div className="overflow-x-auto">
          <table>
            {block.rows.length > 0 && (
              <thead>
                <tr>
                  {block.rows[0].map((cell, i) => (
                    <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                      <Inlines nodes={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.slice(1).map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "hr":
      return <hr />
  }
}

function ListItem({ item }: { item: MdPreviewListItem }) {
  // A tight list item is one paragraph: draw its text inline, as the site does
  const tight = item.c.length === 1 && item.c[0].t === "p"
  return (
    <li className={cn(item.checked !== undefined && "list-none")}>
      {item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled readOnly className="mr-1.5 align-middle" aria-label={item.checked ? "Done" : "Not done"} />}
      {tight && item.c[0].t === "p" ? <Inlines nodes={item.c[0].c} /> : <Blocks blocks={item.c} />}
    </li>
  )
}

function Inlines({ nodes }: { nodes: MdPreviewInline[] }) {
  return nodes.map((node, i) => {
    switch (node.t) {
      case "text":
        return <Fragment key={i}>{node.v}</Fragment>
      case "strong":
        return (
          <strong key={i}>
            <Inlines nodes={node.c} />
          </strong>
        )
      case "em":
        return (
          <em key={i}>
            <Inlines nodes={node.c} />
          </em>
        )
      case "del":
        return (
          <del key={i}>
            <Inlines nodes={node.c} />
          </del>
        )
      case "code":
        return <code key={i}>{node.v}</code>
      case "br":
        return <br key={i} />
      case "link":
        return (
          <PartLink key={i} url={node.url}>
            <Inlines nodes={node.c} />
          </PartLink>
        )
      case "image":
        return (
          <span key={i} className="not-prose inline-flex items-center gap-1 rounded border bg-admin-surface px-1.5 py-0.5 text-xs">
            <ImageIcon aria-hidden className="size-3 text-admin-subtle" />
            <PartLink url={node.url}>{node.alt || "Picture"}</PartLink>
          </span>
        )
    }
  })
}
