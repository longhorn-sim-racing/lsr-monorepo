import Link from "next/link"
import { Fragment, memo, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { carriesData, labelShowsHost, partLink } from "@/lib/jack/links"
import { parseReply, type MdBlock, type MdInline, type MdList } from "@/lib/jack/reply-markdown"
import { LinkHost } from "./parts/part-link"

/*
 * A stretch of a reply's text, with the light formatting Jack writes (#185). Everything is drawn as
 * React elements from the parsed tree, never as HTML, so a reply can't put markup on the page.
 */

const LINK_CLASS = "font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"

type ReplyTextProps = {
  text: string
  /** The end of a reply that's still streaming: marks left open there apply instead of showing */
  streaming: boolean
  /** Drawn at the very end of the text, inline (the streaming cursor) */
  tail?: ReactNode
}

/** Memoized: while a reply streams, only its last stretch of text changes */
export const ReplyText = memo(function ReplyText({ text, streaming, tail = null }: ReplyTextProps) {
  const blocks = parseReply(text, streaming)
  if (!blocks.length) return tail ? <p className="leading-relaxed">{tail}</p> : null
  return (
    <div className="flex flex-col gap-2 break-words leading-relaxed text-foreground">
      {blocks.map((block, i) => (
        <Block key={i} block={block} tail={i === blocks.length - 1 ? tail : null} />
      ))}
    </div>
  )
})

function Block({ block, tail }: { block: MdBlock; tail: ReactNode }) {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return (
        <p className={cn("whitespace-pre-wrap", block.kind === "heading" && "font-semibold")}>
          <Inlines nodes={block.children} />
          {tail}
        </p>
      )
    case "code":
      return (
        <pre className="overflow-x-auto whitespace-pre rounded-md border bg-card p-2.5 font-mono text-xs leading-relaxed">
          {block.text}
          {tail}
        </pre>
      )
    case "rule":
      return (
        <>
          <hr className="border-admin-row" />
          {tail ? <p>{tail}</p> : null}
        </>
      )
    case "list":
      return <ListView list={block} depth={0} tail={tail} />
  }
}

function ListView({ list, depth, tail }: { list: MdList; depth: number; tail: ReactNode }) {
  const Tag = list.ordered ? "ol" : "ul"
  return (
    <Tag
      start={list.ordered && list.start !== 1 ? list.start : undefined}
      className={cn("space-y-1 pl-5 marker:text-admin-subtle", list.ordered ? "list-decimal" : depth ? "list-[circle]" : "list-disc", depth > 0 && "mt-1")}
    >
      {list.items.map((item, i) => {
        const last = i === list.items.length - 1
        return (
          <li key={i} className="whitespace-pre-wrap pl-0.5">
            <Inlines nodes={item.children} />
            {last && !item.lists.length ? tail : null}
            {item.lists.map((sub, j) => (
              <ListView key={j} list={sub} depth={depth + 1} tail={last && j === item.lists.length - 1 ? tail : null} />
            ))}
          </li>
        )
      })}
    </Tag>
  )
}

function Inlines({ nodes }: { nodes: MdInline[] }) {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>
      case "strong":
        return (
          <strong key={i} className="font-semibold">
            <Inlines nodes={node.children} />
          </strong>
        )
      case "em":
        return (
          <em key={i}>
            <Inlines nodes={node.children} />
          </em>
        )
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        )
      case "link":
        return <ReplyLink key={i} href={node.href} label={node.children} />
    }
  })
}

/**
 * A link in a reply (design §7.5). Jack can be talked into writing a link by something he read, with a
 * label that hides where it goes, so it's checked like a part's link (partLink): site pages open in place,
 * like the deck card's links, and only while they stay on this site; web links open in a new tab, show
 * their host after them (unless the text is the URL itself) and the whole URL on hover, and are flagged
 * when opening them hands the site data (carriesData). Email links open as before: the mail app shows the
 * address and waits for Send. Anything else is plain text
 */
function ReplyLink({ href, label }: { href: string; label: MdInline[] }) {
  const text = <Inlines nodes={label} />
  if (/^mailto:/i.test(href))
    return (
      <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {text}
      </a>
    )
  const link = partLink(href)
  if (!link) return text
  if (link.internal)
    return (
      <Link href={link.href} className={LINK_CLASS}>
        {text}
      </Link>
    )
  return (
    <>
      <a href={link.href} title={link.href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {text}
      </a>
      {!labelShowsHost(plainText(label), href) && <LinkHost host={link.host} />}
      {carriesData(link.href) && (
        <span title="Opening this link sends the site what's in it (a long query, an email address or a long number). Check it before you open it." className="ml-1.5 whitespace-nowrap text-xs font-medium text-tone-warning-foreground">
          sends data
        </span>
      )}
    </>
  )
}

/** A label's text as shown, marks left out */
function plainText(nodes: MdInline[]): string {
  return nodes.map((node) => (node.kind === "text" || node.kind === "code" ? node.text : plainText(node.children))).join("")
}
