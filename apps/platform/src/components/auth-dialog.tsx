"use client"

import { useSearchParams } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AuthForms, AuthNotice, type AuthMode } from "@/components/auth/auth-forms"

/** The header's "Sign in / Create account" button and its dialog (also opened by an "open-auth-dialog" event). */
export function AuthDialog() {
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AuthMode>("signup")
  // Bumped each time the dialog opens, so the forms start fresh in the right tab
  const [session, setSession] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const openAs = useCallback((next: AuthMode) => {
    setMode(next)
    setSession((n) => n + 1)
    setOpen(true)
  }, [])

  useEffect(() => {
    const handleOpen = () => openAs("signup")
    window.addEventListener("open-auth-dialog", handleOpen)
    return () => window.removeEventListener("open-auth-dialog", handleOpen)
  }, [openAs])

  // After confirming their email, people land on /?verified=true&message=… (see auth/callback)
  useEffect(() => {
    if (searchParams?.get("verified") === "true") {
      setNotice(searchParams.get("message") ? "Email confirmed. Sign in to finish setting up." : null)
      openAs("signin")
    }
  }, [searchParams, openAs])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          onClick={() => openAs("signup")}
          className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-9 px-3 md:px-6 transition-all"
        >
          <span className="sm:hidden">Sign In</span>
          <span className="hidden sm:inline">Sign In / Create Account</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[92svh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-none border-white/10 bg-lsr-charcoal p-0 shadow-2xl">
        <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
        <DialogHeader className="px-6 pt-8 text-left sm:px-8">
          <DialogTitle className="font-display font-black italic text-3xl uppercase tracking-normal text-white">
            {mode === "signup" ? (
              <>
                Join the <span className="text-lsr-orange">grid</span>
              </>
            ) : (
              <>
                Welcome <span className="text-lsr-orange">back</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription className="font-sans text-sm text-white/60">
            {mode === "signup" ? "Free, and it takes a minute. You get a driver page and can register for anything on the calendar." : "Sign in to register for events and manage your driver page."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 px-6 pb-8 pt-6 sm:px-8">
          {notice && mode === "signin" && <AuthNotice tone="success">{notice}</AuthNotice>}
          <AuthForms
            key={session}
            initialMode={mode}
            onModeChange={setMode}
            onSignedIn={() => setOpen(false)}
            onNavigate={() => setOpen(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
