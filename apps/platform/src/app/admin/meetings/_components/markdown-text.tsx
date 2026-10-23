"use client"

import { ReplyText } from "@/components/jack/reply-text"

/**
 * An agenda or summary with light formatting (lists, bold, links), drawn the way Jack's replies are:
 * from a parsed tree, never as HTML, so text Jack or an officer wrote can't put markup on the page
 */
export function MarkdownText({ text }: { text: string }) {
  return <ReplyText text={text} streaming={false} />
}
