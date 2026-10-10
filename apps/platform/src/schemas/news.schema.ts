import { z } from "zod";

export const newsPostSchema = z.object({
  title: z.string().min(1, "Title is required"),
  slug: z.string().min(1, "Slug is required")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase, alphanumeric, and hyphenated"),
  excerpt: z.string().optional(),
  coverImageUrl: z
    .string()
    .regex(/^https:\/\/res\.cloudinary\.com\/[\w-]+\/image\/upload\/[^\s"<>]+$/, "Cover images must be uploaded to Cloudinary")
    .nullable()
    .optional(),
  bodyMd: z.string().min(1, "Content is required"),
  authorId: z.string().min(1, "Author is required"),
  publishedAt: z.date().nullable().optional(), // Nullable for drafts
  tags: z.array(z.string()),
});

export type NewsPostSchema = z.infer<typeof newsPostSchema>;