"use client"

import * as AvatarPrimitive from "@radix-ui/react-avatar"
import { cn } from "@/lib/utils"

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

/** A member's round avatar, with their initials while the photo loads or when they have none. */
export function MemberAvatar({ name, src, size = "sm", className }: { name: string; src: string | null; size?: "sm" | "lg"; className?: string }) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative flex shrink-0 overflow-hidden rounded-full border bg-admin-surface", size === "sm" ? "size-7" : "size-12", className)}
    >
      {src && <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" />}
      <AvatarPrimitive.Fallback className={cn("flex size-full items-center justify-center font-semibold text-admin-subtle", size === "sm" ? "text-[11px]" : "text-sm")}>
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}
