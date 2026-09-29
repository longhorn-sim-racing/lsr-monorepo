import { compileMDX } from "next-mdx-remote/rsc"
import remarkGfm from "remark-gfm"
import rehypeSlug from "rehype-slug"
import { prisma } from "@/server/db"

/** Content pages officers edit in /admin/pages (the LSC rules, for now). */
export const LSC_RULES_SLUG = "lone-star-cup-rules"

export async function getPageBySlug(slug: string) {
  return prisma.page.findUnique({ where: { slug } })
}

/**
 * Renders a page's markdown. Plain Markdown only (format "md"): no JSX, no raw HTML and
 * no expressions, since several people can edit these and they render on public pages.
 */
export async function renderPageMarkdown(bodyMd: string) {
  const { content } = await compileMDX({
    source: bodyMd,
    options: {
      parseFrontmatter: false,
      mdxOptions: {
        format: "md",
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSlug],
      },
    },
  })
  return content
}
