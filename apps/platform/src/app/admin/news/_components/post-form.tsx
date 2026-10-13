"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import { toast } from "sonner"
import { newsPostSchema, type NewsPostSchema } from "@/schemas/news.schema"
import { createPost, updatePost } from "@/server/actions/news"
import { deletePost } from "@/app/admin/news/actions"
import { slugify } from "@/lib/slug"
import { DEFAULT_TIMEZONE, dateToZonedValue, zoneLabel } from "@/lib/dates"
import { unexpectedError } from "@/lib/action-result"
import { ImageUploader } from "@/components/image-uploader"
import {
  Badge,
  Button,
  Field,
  FormActions,
  FormSection,
  Input,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  SplitLayout,
  Textarea,
  UserPicker,
  useConfirm,
  type AdminUserOption,
} from "@/components/admin/kit"
import { TagPicker } from "./tag-picker"

interface PostFormProps {
  post?: NewsPostSchema & { id: string }
  /** The post's current author, for the picker */
  author: AdminUserOption | null
  availableTags: string[]
}

function centralTime(date: Date) {
  return `${formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, yyyy, h:mm a")} ${zoneLabel(date, DEFAULT_TIMEZONE)}`
}

function publishState(publishedAt: Date | null | undefined) {
  if (!publishedAt) return { badge: <Badge>Draft</Badge>, note: "Only officers can see it." }
  if (publishedAt.getTime() > Date.now()) return { badge: <Badge tone="info">Scheduled</Badge>, note: `Goes live ${centralTime(publishedAt)}.` }
  return { badge: <Badge tone="success">Published</Badge>, note: `Live since ${centralTime(publishedAt)}.` }
}

export function PostForm({ post, author: initialAuthor, availableTags }: PostFormProps) {
  const router = useRouter()
  const confirm = useConfirm()
  const [isPending, startTransition] = useTransition()
  const [deleting, setDeleting] = useState(false)
  const [author, setAuthor] = useState<AdminUserOption | null>(initialAuthor)
  // New posts take their slug from the title until the slug is edited by hand
  const [slugEdited, setSlugEdited] = useState(!!post)

  const defaults: NewsPostSchema = {
    title: post?.title ?? "",
    slug: post?.slug ?? "",
    excerpt: post?.excerpt ?? "",
    coverImageUrl: post?.coverImageUrl ?? null,
    bodyMd: post?.bodyMd ?? "",
    authorId: post?.authorId ?? initialAuthor?.id ?? "",
    publishedAt: post?.publishedAt ?? null,
    tags: post?.tags ?? [],
  }
  const form = useForm<NewsPostSchema>({
    resolver: zodResolver(newsPostSchema),
    defaultValues: defaults,
  })
  const { errors, isSubmitted } = form.formState

  function onSubmit(data: NewsPostSchema) {
    startTransition(async () => {
      try {
        const result = post ? await updatePost(post.id, data) : await createPost(data)
        if (result.success) {
          toast.success(post ? "Post saved" : data.publishedAt ? "Post created" : "Draft saved")
          router.push("/admin/news")
          router.refresh()
        } else {
          toast.error(result.error)
        }
      } catch (error) {
        toast.error(unexpectedError(error, "Couldn't save the post"))
      }
    })
  }

  async function onDelete() {
    if (!post) return
    const ok = await confirm({
      tone: "danger",
      title: `Delete "${post.title}"?`,
      description: "The post comes off the news page and its link stops working. This can't be undone.",
    })
    if (!ok) return
    setDeleting(true)
    try {
      await deletePost(post.id)
      toast.success("Post deleted")
      router.push("/admin/news")
      router.refresh()
    } catch (error) {
      toast.error(unexpectedError(error, "Couldn't delete the post"))
      setDeleting(false)
    }
  }

  const publishedAt = form.watch("publishedAt")
  const body = form.watch("bodyMd")
  const words = body.trim() ? body.trim().split(/\s+/).length : 0
  const state = publishState(publishedAt)
  const scheduled = !!publishedAt && publishedAt.getTime() > Date.now()
  const submitLabel = post ? "Save changes" : !publishedAt ? "Save draft" : scheduled ? "Schedule post" : "Publish post"

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(onSubmit, () => toast.error("Some fields need fixing before this can be saved."))}
    >
      <SplitLayout
        main={
          <Panel>
            <PanelHeader title="Post" description="Written in Markdown: **bold**, _italic_, # headings, [links](https://…) and lists." />
            <PanelBody className="flex flex-col gap-4">
              <Field label="Title" htmlFor="post-title" required error={errors.title?.message}>
                <Input
                  id="post-title"
                  placeholder="LSC Season 3 kicks off"
                  aria-invalid={!!errors.title}
                  defaultValue={defaults.title}
                  {...form.register("title", {
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                      if (!slugEdited) form.setValue("slug", slugify(event.target.value), { shouldValidate: isSubmitted })
                    },
                  })}
                />
              </Field>
              <Field
                label="Link"
                htmlFor="post-slug"
                required
                error={errors.slug?.message}
                hint={post ? "Changing it breaks links already shared." : "Filled in from the title. Lowercase letters, numbers and hyphens."}
              >
                <div className="flex min-w-0 items-center rounded-md">
                  <span className="flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-input bg-admin-surface px-2.5 text-[13px] text-admin-subtle">
                    /news/
                  </span>
                  <Input
                    id="post-slug"
                    placeholder="lsc-season-3-kicks-off"
                    className="rounded-l-none"
                    aria-invalid={!!errors.slug}
                    defaultValue={defaults.slug}
                    {...form.register("slug", { onChange: () => setSlugEdited(true) })}
                  />
                </div>
              </Field>
              <Field label="Excerpt" htmlFor="post-excerpt" hint="One or two sentences for the news page and link previews." error={errors.excerpt?.message}>
                <Textarea id="post-excerpt" rows={2} placeholder="A short summary" defaultValue={defaults.excerpt} {...form.register("excerpt")} />
              </Field>
              <Field
                label="Body"
                htmlFor="post-body"
                required
                error={errors.bodyMd?.message}
                hint={`${words.toLocaleString()} ${words === 1 ? "word" : "words"}`}
              >
                <Textarea
                  id="post-body"
                  rows={20}
                  className="min-h-[420px]"
                  placeholder="Write the post here."
                  aria-invalid={!!errors.bodyMd}
                  defaultValue={defaults.bodyMd}
                  {...form.register("bodyMd")}
                />
              </Field>
            </PanelBody>
          </Panel>
        }
        side={
          <div className="flex flex-col gap-4">
            <Panel>
              <PanelHeader title="Publishing" description={<span className="flex flex-wrap items-center gap-2">{state.badge}{state.note}</span>} />
              <PanelBody className="flex flex-col gap-4">
                <Controller
                  control={form.control}
                  name="publishedAt"
                  render={({ field }) => (
                    <Field
                      label="Publish date (Central)"
                      htmlFor="post-published-at"
                      hint="Blank keeps it a draft. A future time schedules it."
                      error={errors.publishedAt?.message}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          id="post-published-at"
                          type="datetime-local"
                          className="w-auto min-w-0 flex-1"
                          value={dateToZonedValue(field.value, DEFAULT_TIMEZONE)}
                          onChange={(event) => field.onChange(event.target.value ? fromZonedTime(event.target.value, DEFAULT_TIMEZONE) : null)}
                          onBlur={field.onBlur}
                        />
                        <Button type="button" size="sm" onClick={() => field.onChange(new Date())}>
                          Now
                        </Button>
                        {field.value && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => field.onChange(null)}>
                            Clear
                          </Button>
                        )}
                      </div>
                    </Field>
                  )}
                />
                <Field label="Author" htmlFor="post-author" required error={errors.authorId?.message}>
                  <UserPicker
                    id="post-author"
                    value={author}
                    placeholder="Choose the author"
                    onChange={(user) => {
                      setAuthor(user)
                      form.setValue("authorId", user?.id ?? "", { shouldValidate: isSubmitted, shouldDirty: true })
                    }}
                  />
                </Field>
              </PanelBody>
              <PanelFooter>
                <FormActions
                  className="w-full"
                  note={
                    post && (
                      <Button type="button" variant="danger" onClick={onDelete} pending={deleting} disabled={isPending}>
                        Delete
                      </Button>
                    )
                  }
                >
                  <Button asChild>
                    <Link href="/admin/news">Cancel</Link>
                  </Button>
                  <Button type="submit" variant="primary" pending={isPending} disabled={deleting}>
                    {submitLabel}
                  </Button>
                </FormActions>
              </PanelFooter>
            </Panel>

            <Panel>
              <PanelBody className="flex flex-col gap-5">
                <FormSection title="Tags" description="Group related posts. Type a new name to create a tag.">
                  <Controller
                    control={form.control}
                    name="tags"
                    render={({ field }) => <TagPicker id="post-tags" value={field.value} onChange={field.onChange} options={availableTags} />}
                  />
                </FormSection>
                <FormSection title="Cover image" description="Shown on the news page and at the top of the post. Landscape photos work best.">
                  <Controller
                    control={form.control}
                    name="coverImageUrl"
                    render={({ field }) => (
                      <div className="flex flex-col gap-1.5">
                        <ImageUploader id="post-cover" defaultValue={field.value} onChange={(url) => field.onChange(url)} aria-invalid={!!errors.coverImageUrl} />
                        {errors.coverImageUrl?.message && (
                          <p role="alert" className="text-xs font-medium text-tone-danger-foreground">
                            {errors.coverImageUrl.message}
                          </p>
                        )}
                      </div>
                    )}
                  />
                </FormSection>
              </PanelBody>
            </Panel>
          </div>
        }
      />
    </form>
  )
}
