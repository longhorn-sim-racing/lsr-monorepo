"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AuthChangeEvent, Session } from "@supabase/supabase-js"
import { Loader2 } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthNotice, authInput, authLabel, authSubmit } from "@/components/auth/auth-forms"
import { AuthShell } from "../auth-shell"

// Helper to decode JWT payload safely on client
function decodeJwtPayload(token: string) {
  try {
    const base64Url = token.split(".")[1]
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/")
    const jsonPayload = decodeURIComponent(
      window
        .atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    )
    return JSON.parse(jsonPayload)
  } catch {
    return null
  }
}

/** How long to wait for the reset link's session before calling the link expired */
const LINK_TIMEOUT_MS = 6000

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState("")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState("")
  const [state, setState] = useState<"checking" | "allowed" | "expired" | "done">("checking")
  const router = useRouter()

  useEffect(() => {
    const supabase = createSupabaseBrowser()
    // Only a session that came from a reset link may set a new password here
    const checkSession = (session: Session | null) => {
      if (!session) return
      const payload = session.access_token ? decodeJwtPayload(session.access_token) : null
      const amr = payload?.amr || []
      const isRecovery = amr.some((m: { method?: string }) => m.method === "recovery")
      if (isRecovery) setState("allowed")
      else router.replace("/")
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) checkSession(session)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event: AuthChangeEvent, session: Session | null) => {
      if (event === "PASSWORD_RECOVERY") setState("allowed")
      else if (event === "SIGNED_IN" && session) checkSession(session)
      else if (event === "SIGNED_OUT") router.replace("/")
    })

    // No recovery session arriving means the link was used, expired, or opened without one
    const timeout = window.setTimeout(() => setState((s) => (s === "checking" ? "expired" : s)), LINK_TIMEOUT_MS)

    return () => {
      subscription.unsubscribe()
      window.clearTimeout(timeout)
    }
  }, [router])

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError("")
    startTransition(async () => {
      const supabase = createSupabaseBrowser()
      const { error } = await supabase.auth.updateUser({ password })
      if (error) return setError(error.message)
      setState("done")
      window.setTimeout(() => router.push("/"), 1800)
    })
  }

  return (
    <AuthShell
      kicker="Account help"
      title={
        <>
          Set a new <span className="text-lsr-orange">password</span>
        </>
      }
      intro={state === "allowed" ? "Choose something you don't use anywhere else." : undefined}
    >
      {state === "checking" && (
        <p className="flex items-center gap-3 font-sans text-sm text-white/60" role="status">
          <Loader2 className="h-4 w-4 animate-spin text-lsr-orange" aria-hidden />
          Checking your reset link…
        </p>
      )}

      {state === "expired" && (
        <div className="space-y-5">
          <AuthNotice tone="error">This reset link has expired or was already used. Request a new one and open it on this device.</AuthNotice>
          <Button asChild className={authSubmit}>
            <Link href="/auth/forgot-password">Send a new link</Link>
          </Button>
        </div>
      )}

      {state === "done" && <AuthNotice tone="success">Password updated. Taking you home…</AuthNotice>}

      {state === "allowed" && (
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="password" className={authLabel}>New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              disabled={pending}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={authInput}
            />
          </div>
          {error && <AuthNotice tone="error">{error}</AuthNotice>}
          <Button disabled={pending} className={authSubmit}>
            {pending ? "Saving…" : "Save new password"}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
