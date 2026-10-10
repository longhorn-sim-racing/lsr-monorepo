"use client"

import { UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"

export function CreateAccountButton() {
  return (
    <Button
      onClick={() => window.dispatchEvent(new CustomEvent("open-auth-dialog"))}
      className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all"
    >
      <UserPlus className="w-3.5 h-3.5 mr-2" />
      Create an account
    </Button>
  )
}
