"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { useRouter } from "next/navigation"
import { useTransition, useState } from "react"
import { newsPostSchema, NewsPostSchema } from "@/schemas/news.schema"
import { createPost, updatePost } from "@/server/actions/news"
import { slugify } from "@/lib/slug"
import { cn } from "@/lib/utils"
import { ImageUploader } from "@/components/image-uploader"

import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Check, ChevronsUpDown, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface PostFormProps {
  post?: NewsPostSchema & { id: string }
  users: { id: string; displayName: string }[]
  availableTags: string[]
}

export function PostForm({ post, users, availableTags }: PostFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  
  // Author Combobox state
  const [openAuthor, setOpenAuthor] = useState(false)

  // Tag Combobox state
  const [openTag, setOpenTag] = useState(false)
  const [tagInput, setTagInput] = useState("")

  const form = useForm<NewsPostSchema>({
    resolver: zodResolver(newsPostSchema),
    defaultValues: {
      title: post?.title ?? "",
      slug: post?.slug ?? "",
      excerpt: post?.excerpt ?? "",
      coverImageUrl: post?.coverImageUrl ?? null,
      bodyMd: post?.bodyMd ?? "",
      authorId: post?.authorId ?? "", 
      publishedAt: post?.publishedAt ?? null,
      tags: post?.tags ?? [],
    },
  })

  function onSubmit(data: NewsPostSchema) {
    startTransition(async () => {
      let result;
      if (post) {
        result = await updatePost(post.id, data);
      } else {
        result = await createPost(data);
      }

      if (result.success) {
        router.push("/admin/news");
        router.refresh();
      } else {
        alert("Error: " + result.error);
      }
    })
  }

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    form.setValue("title", e.target.value);
    if (!post) { 
        const slug = slugify(e.target.value);
        form.setValue("slug", slug);
    }
  }

  const currentTags = form.watch("tags");

  const addTag = (tag: string) => {
    if (!currentTags.includes(tag)) {
      form.setValue("tags", [...currentTags, tag]);
    }
    setTagInput("");
  }

  const removeTag = (tag: string) => {
    form.setValue("tags", currentTags.filter(t => t !== tag));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 max-w-4xl">
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
                <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl>
                    <Input placeholder="Post title" {...field} onChange={(e) => {
                        field.onChange(e);
                        handleTitleChange(e);
                    }} />
                </FormControl>
                <FormMessage />
                </FormItem>
            )}
            />
            
            <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
                <FormItem>
                <FormLabel>Slug</FormLabel>
                <FormControl>
                    <Input placeholder="post-slug" {...field} />
                </FormControl>
                <FormMessage />
                </FormItem>
            )}
            />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <FormField
              control={form.control}
              name="authorId"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Author</FormLabel>
                  <Popover open={openAuthor} onOpenChange={setOpenAuthor}>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={openAuthor}
                          className={cn(
                            "w-full justify-between",
                            !field.value && "text-muted-foreground"
                          )}
                        >
                          {field.value
                            ? users.find((user) => user.id === field.value)?.displayName
                            : "Select author..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                      <Command>
                        <CommandInput placeholder="Search author..." />
                        <CommandList>
                            <CommandEmpty>No author found.</CommandEmpty>
                            <CommandGroup>
                            {users.map((user) => (
                                <CommandItem
                                value={user.displayName}
                                key={user.id}
                                onSelect={() => {
                                    form.setValue("authorId", user.id)
                                    setOpenAuthor(false)
                                }}
                                >
                                <Check
                                    className={cn(
                                    "mr-2 h-4 w-4",
                                    user.id === field.value ? "opacity-100" : "opacity-0"
                                    )}
                                />
                                {user.displayName}
                                </CommandItem>
                            ))}
                            </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="publishedAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Published Date (Optional)</FormLabel>
                  <FormControl>
                    <Input 
                        type="datetime-local" 
                        value={field.value ? new Date(field.value.getTime() - field.value.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (!val) {
                                field.onChange(null);
                            } else {
                                field.onChange(new Date(val));
                            }
                        }}
                    />
                  </FormControl>
                  <FormDescription>Leave blank to save as draft.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
        </div>

        {/* Tags */}
        <FormItem>
            <FormLabel>Tags</FormLabel>
            <div className="flex flex-wrap gap-2 mb-2">
                {currentTags.map(tag => (
                    <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                        {tag}
                        <span className="cursor-pointer rounded-full hover:bg-muted p-0.5" onClick={() => removeTag(tag)}>
                            <X className="w-3 h-3" />
                        </span>
                    </Badge>
                ))}
            </div>
            <Popover open={openTag} onOpenChange={setOpenTag}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={openTag}
                        className="justify-between"
                    >
                        Add Tag...
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0" align="start">
                    <Command>
                        <CommandInput 
                            placeholder="Search or create tag..." 
                            value={tagInput}
                            onValueChange={setTagInput} 
                        />
                        <CommandList>
                            <CommandEmpty>
                                {tagInput && (
                                    <div className="p-2">
                                        <div 
                                            className="text-sm cursor-pointer hover:bg-accent hover:text-accent-foreground rounded-sm px-2 py-1.5"
                                            onClick={() => {
                                                addTag(tagInput);
                                                setOpenTag(false);
                                            }}
                                        >
                                            Create "{tagInput}"
                                        </div>
                                    </div>
                                )}
                            </CommandEmpty>
                            <CommandGroup heading="Existing Tags">
                                {availableTags.filter(t => !currentTags.includes(t)).map(tag => (
                                    <CommandItem
                                        key={tag}
                                        value={tag}
                                        onSelect={() => {
                                            addTag(tag);
                                            setOpenTag(false);
                                        }}
                                    >
                                        <Check className={cn("mr-2 h-4 w-4 opacity-0")} />
                                        {tag}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
        </FormItem>


        <FormField
          control={form.control}
          name="coverImageUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cover image</FormLabel>
              <ImageUploader defaultValue={field.value} onChange={(url) => field.onChange(url)} />
              <FormDescription>Optional. Shown on the news page and at the top of the post; landscape photos work best.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="excerpt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Excerpt</FormLabel>
              <FormControl>
                <Textarea placeholder="Brief summary..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="bodyMd"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Content (Markdown)</FormLabel>
              <FormControl>
                <Textarea placeholder="Type your markdown here..." className="h-96 font-mono" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-4">
            <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : (post ? "Update Post" : "Create Post")}
            </Button>
            <Button variant="outline" type="button" onClick={() => router.back()}>
                Cancel
            </Button>
        </div>
      </form>
    </Form>
  )
}