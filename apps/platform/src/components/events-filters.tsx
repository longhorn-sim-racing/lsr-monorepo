"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Filter, X } from "lucide-react"

export function EventsFilters({ allTypes }: {
  allTypes: string[],
}) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const selectedTypes = (searchParams?.getAll("type") ?? []).map(t => t.toLowerCase())

  const handleSelect = (type: string) => {
    const params = new URLSearchParams(searchParams)
    const currentTypes = params.getAll("type")

    if (currentTypes.includes(type)) {
      params.delete("type")
      currentTypes.filter(t => t !== type).forEach(t => params.append("type", t))
    } else {
      params.append("type", type)
    }

    router.replace(`${pathname}?${params.toString()}`)
  }
  
  const clearFilters = () => {
    const sp = new URLSearchParams(searchParams ?? undefined)
    sp.delete("type")
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
  }
  
  const active = selectedTypes.length > 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="rounded-none border-white/10 bg-white/5 hover:bg-white/10 font-sans font-bold uppercase tracking-widest text-[10px] h-9">
          <Filter className="h-3 w-3 mr-2" />
          Filter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 bg-lsr-charcoal border-white/10 rounded-none p-2 shadow-2xl">
        <DropdownMenuLabel className="font-sans font-black text-[9px] uppercase tracking-[0.3em] text-white/20 px-2 py-3">Event Series</DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-white/5" />
        {allTypes.map(type => (
          <DropdownMenuCheckboxItem
            key={type}
            checked={selectedTypes.includes(type.toLowerCase())}
            onCheckedChange={() => handleSelect(type.toLowerCase())}
            className="capitalize rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-lsr-orange focus:text-white cursor-pointer data-[state=checked]:text-lsr-orange data-[state=checked]:focus:text-white"
          >
            {type}
          </DropdownMenuCheckboxItem>
        ))}
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
