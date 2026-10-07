"use client"

import { useRouter, usePathname } from "next/navigation"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { Suspense, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Shield, User as UserIcon, Settings, LogOut } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusIcons } from "@/components/status-indicators";
import { getStatusIndicators } from "@/lib/status-indicators";
import { AuthDialog } from "./auth-dialog";
import { User } from "@prisma/client";
import { motion, AnimatePresence } from "framer-motion";

export function UserMenuClient({
  user,
  roles,
  activeTierKey,
}: {
  user: User | null
  roles: string[]
  activeTierKey: string | null
}) {
  const supabase = createSupabaseBrowser()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  async function logout() {
    try {
      await supabase.auth.signOut()
    } catch {
      // ignore
    }
    // Re-run the current route on the server so the header updates
    router.replace(pathname ?? "/")
    router.refresh()
  }

  const initials = user?.displayName
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()

  const isAdmin = roles.includes("admin") || roles.includes("officer");

  return (
    <AnimatePresence mode="wait" initial={false}>
      {!user ? (
        <motion.div
          key="auth-trigger"
          layout
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2 }}
        >
          <Suspense><AuthDialog /></Suspense>
        </motion.div>
      ) : (
        <motion.div
          key="user-trigger"
          layout
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2 }}
        >
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-10 gap-2 sm:gap-3 rounded-none border-white/10 bg-white/5 hover:bg-white/10 text-white font-bold transition-all px-2 sm:px-4">
                <Avatar className="h-6 w-6 rounded-none border border-white/20">
                  <AvatarImage src={user.avatarUrl ?? undefined} alt={user.displayName ?? 'User avatar'} className="rounded-none" />
                  <AvatarFallback className="text-[9px] font-black uppercase bg-lsr-orange text-white rounded-none">{initials || "U"}</AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline-flex items-center gap-1.5 truncate max-w-[10rem] font-sans text-[10px] uppercase tracking-widest leading-none">
                  {user.displayName}
                  <TooltipProvider>
                    <StatusIcons
                      indicators={getStatusIndicators({
                        roles,
                        activeTierKey,
                        officerTitle: user.officerTitle,
                      })}
                      size={10}
                    />
                  </TooltipProvider>
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 bg-lsr-charcoal border-white/10 rounded-none p-2 shadow-2xl">
              <DropdownMenuLabel className="p-4">
                <div className="truncate font-sans font-bold text-white uppercase tracking-tight text-sm">{user.displayName}</div>
                {user.email && <div className="text-[9px] font-bold text-white/30 uppercase tracking-widest truncate mt-1">{user.email}</div>}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-white/5" />

              <DropdownMenuItem
                onSelect={() => router.push(`/drivers/${user.handle}`)}
                className="rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-lsr-orange focus:text-white cursor-pointer"
              >
                <UserIcon className="mr-2 h-3 w-3" />
                <span>My driver page</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => router.push("/account")}
                className="rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-lsr-orange focus:text-white cursor-pointer"
              >
                <Settings className="mr-2 h-3 w-3" />
                <span>Account Settings</span>
              </DropdownMenuItem>

              {isAdmin && (
                <DropdownMenuItem
                  onSelect={() => router.push("/admin")}
                  className="rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-lsr-orange focus:text-white cursor-pointer"
                >
                  <Shield className="mr-2 h-3 w-3" />
                  <span>Admin Console</span>
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator className="bg-white/5" />

              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  logout()
                }}
                className="rounded-none font-sans font-bold text-[10px] uppercase tracking-widest py-3 focus:bg-red-600 focus:text-white cursor-pointer"
              >
                <LogOut className="mr-2 h-3 w-3" />
                <span>Log out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
