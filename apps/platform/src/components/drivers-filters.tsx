"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Filter, X } from "lucide-react"
import { ROLE_LABEL, type RoleCode } from "@/lib/roles"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"

const ALL_ROLES = Object.keys(ROLE_LABEL) as RoleCode[]

export function DriversFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const selectedRoles = (searchParams?.getAll("role") ?? []).filter(
    (r): r is RoleCode => ALL_ROLES.includes(r as RoleCode),
  )

  const toggleRole = (role: RoleCode, checked: boolean) => {
    const sp = new URLSearchParams(searchParams ?? undefined)
    const current = (sp.getAll("role") as string[]).filter(Boolean) as RoleCode[]
    const next = new Set<RoleCode>(current)
    if (checked) next.add(role)
    else next.delete(role)
    sp.delete("role")
    ;[...next].forEach((r) => sp.append("role", r))
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
  }

  const clearFilters = () => {
    const sp = new URLSearchParams(searchParams ?? undefined)
    sp.delete("role")            // keep `q` intact
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
  }

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
        <DropdownMenuLabel className="font-sans font-black text-[9px] uppercase tracking-[0.3em] text-white/20 px-2 py-3">
          Driver Roles
        </DropdownMenuLabel>

        <div className="px-1 py-2">
          {ALL_ROLES.map((role) => (
            <DropdownMenuCheckboxItem
              key={role}
              checked={selectedRoles.includes(role)}
              onCheckedChange={(v) => toggleRole(role, Boolean(v))}
              className="capitalize rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-lsr-orange focus:text-white cursor-pointer data-[state=checked]:text-lsr-orange data-[state=checked]:focus:text-white"
            >
              {ROLE_LABEL[role]}
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
          >
            <X className="mr-2 h-3 w-3" />
            Clear filters
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
