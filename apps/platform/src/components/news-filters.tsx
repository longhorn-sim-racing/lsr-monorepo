"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Filter, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"

type Props = { 
  allTags: string[],
  selectedTags: string[]
}

export function NewsFilters({ allTags, selectedTags }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const toggleTag = (tag: string, checked: boolean) => {
    const sp = new URLSearchParams(searchParams ?? undefined)
    const current = (sp.getAll("tag") as string[]).filter(Boolean)
    const next = new Set<string>(current)
    if (checked) next.add(tag)
    else next.delete(tag)
    sp.delete("tag")
    ;[...next].forEach((t) => sp.append("tag", t))
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
  }

  const clearFilters = () => {
    const sp = new URLSearchParams(searchParams ?? undefined)
    sp.delete("tag")
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
  }

  const active = selectedTags.length > 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="rounded-none border-white/10 bg-white/5 hover:bg-white/10 font-sans font-bold uppercase tracking-widest text-[10px] h-9"
        >
          <Filter className="h-3 w-3 mr-2" />
          Filter
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72 bg-lsr-charcoal border-white/10 rounded-none p-2 shadow-2xl">
        <DropdownMenuLabel className="font-sans font-black text-[9px] uppercase tracking-[0.3em] text-white/20 px-2 py-3">Topic Tags</DropdownMenuLabel>

        <div className="px-1 py-2">
          {allTags.map((tag) => (
            <DropdownMenuCheckboxItem
              key={tag}
              checked={selectedTags.includes(tag.toLowerCase())}
              onCheckedChange={(v) => toggleTag(tag.toLowerCase(), Boolean(v))}
              className="capitalize rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-lsr-orange focus:text-white cursor-pointer data-[state=checked]:text-lsr-orange data-[state=checked]:focus:text-white"
            >
              {tag}
            </DropdownMenuCheckboxItem>
          ))}
        </div>

        <DropdownMenuSeparator className="bg-white/5" />
        <div className="p-2">
          <Button 
            variant="ghost" 
            size="sm" 
            className="w-full rounded-none font-sans font-bold uppercase tracking-widest text-[10px] hover:bg-red-900/50 hover:text-white transition-colors" 
            onClick={clearFilters} 
            disabled={!active}
          >
            <X className="mr-2 h-3 w-3" />
            Clear filters
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}