"use client"

import Image, { type ImageLoaderProps, type ImageProps } from "next/image"
import { cloudinaryUrl } from "@/lib/cloudinary"

type Props = Omit<ImageProps, "src" | "loader"> & { publicId: string }

/** next/image backed by Cloudinary resizing: `src` is the Cloudinary public id. */
export function CloudinaryImage({ publicId, alt, ...props }: Props) {
  return (
    <Image
      {...props}
      alt={alt}
      src={publicId}
      loader={({ width, quality }: ImageLoaderProps) => cloudinaryUrl(publicId, { width, quality: quality ?? "auto" })}
    />
  )
}
