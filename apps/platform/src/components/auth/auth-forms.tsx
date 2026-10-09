"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { AlertCircle, CheckCircle2, MailCheck } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { GoogleButton } from "@/components/google-button"

export type AuthMode = "signin" | "signup"

export const authLabel = "font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white/55"
// 16px text on phones so iOS doesn't zoom into the field
export const authInput =
  "h-11 rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm"
export const authSubmit =
  "h-12 w-full rounded-none bg-lsr-orange font-sans text-xs font-bold uppercase tracking-[0.2em] text-white transition-colors hover:bg-white hover:text-lsr-charcoal"

export function AuthNotice({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  const Icon = tone === "error" ? AlertCircle : CheckCircle2
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 border px-4 py-3 font-sans text-sm leading-relaxed",
        tone === "error" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  )
}

function OrDivider() {
  return (
    <div className="relative" aria-hidden>
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-white/10" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-lsr-charcoal px-3 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/35">or</span>
      </div>
    </div>
  )
}

/**
 * Sign in and create account, as tabs. Used by /auth/signin and the header's dialog, so both behave
 * the same: errors and the "check your email" step show inline instead of browser alerts.
 */
export function AuthForms({
  initialMode = "signin",
  next,
  onSignedIn,
  onNavigate,
  onModeChange,
}: {
  initialMode?: AuthMode
  /** Where to go after signing in; without it the current page refreshes */
  next?: string
  /** Called after a successful sign-in (the dialog closes itself) */
  onSignedIn?: () => void
  /** Called when a link inside leaves the form (the dialog closes itself) */
  onNavigate?: () => void
  /** Lets the surrounding page follow the tab, e.g. for its heading */
  onModeChange?: (mode: AuthMode) => void
}) {
  const router = useRouter()
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [eid, setEid] = useState("")
  const [marketing, setMarketing] = useState(true)

  function switchMode(to: AuthMode) {
    setMode(to)
    setError(null)
    onModeChange?.(to)
  }

  function onSignin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const supabase = createSupabaseBrowser()
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) return setError(error.message)
      if (data.user && !data.user.email_confirmed_at) {
        return setError("Please confirm your email first: open the link we sent you, then sign in.")
      }
      onSignedIn?.()
      if (next) router.push(next)
      router.refresh()
    })
  }

  function onSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const supabase = createSupabaseBrowser()
      const origin = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${origin.replace(/\/$/, "")}/auth/callback`,
          data: { displayName, eid, marketingOptIn: marketing },
        },
      })
      if (error) return setError(error.message)
      setSentTo(email)
    })
  }

  if (sentTo) {
    return (
      <div className="space-y-5 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center bg-lsr-orange/15 text-lsr-orange">
          <MailCheck className="h-7 w-7" aria-hidden />
        </span>
        <div>
          <p className="font-display font-black italic text-2xl uppercase text-white">Check your email</p>
          <p className="mt-2 font-sans text-sm leading-relaxed text-white/65">
            We sent a confirmation link to <span className="font-bold text-white">{sentTo}</span>. Open it, then sign in.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setSentTo(null)
            switchMode("signin")
          }}
          className={authSubmit}
        >
          I&apos;ve confirmed, sign me in
        </Button>
      </div>
    )
  }

  const tabClass = (active: boolean) =>
    cn(
      "h-11 font-sans font-bold text-[11px] uppercase tracking-[0.2em] transition-colors",
      active ? "bg-lsr-orange text-white" : "text-white/60 hover:text-white",
    )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 border border-white/10 bg-white/[0.03] p-1" role="group" aria-label="Sign in or create an account">
        <button type="button" aria-pressed={mode === "signin"} onClick={() => switchMode("signin")} className={tabClass(mode === "signin")}>
          Sign in
        </button>
        <button type="button" aria-pressed={mode === "signup"} onClick={() => switchMode("signup")} className={tabClass(mode === "signup")}>
          Create account
        </button>
      </div>

      <GoogleButton next={next} />
      <OrDivider />

      {mode === "signin" ? (
        <form onSubmit={onSignin} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="auth-email" className={authLabel}>Email</Label>
            <Input id="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={authInput} placeholder="you@utexas.edu" required />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="auth-password" className={authLabel}>Password</Label>
              <Link href="/auth/forgot-password" onClick={onNavigate} className="font-sans font-bold text-[11px] uppercase tracking-[0.15em] text-lsr-orange hover:text-white">
                Forgot it?
              </Link>
            </div>
            <Input id="auth-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={authInput} required />
          </div>
          {error && <AuthNotice tone="error">{error}</AuthNotice>}
          <Button type="submit" disabled={pending} className={authSubmit}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-center font-sans text-sm text-white/55">
            New to LSR?{" "}
            <button type="button" onClick={() => switchMode("signup")} className="font-bold text-lsr-orange hover:text-white">
              Create an account
            </button>
          </p>
        </form>
      ) : (
        <form onSubmit={onSignup} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="auth-name" className={authLabel}>Full name</Label>
            <Input id="auth-name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={authInput} placeholder="Your name on the roster" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-email" className={authLabel}>Email</Label>
            <Input id="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={authInput} placeholder="you@utexas.edu" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-password" className={authLabel}>Password</Label>
            <Input id="auth-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={authInput} minLength={6} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-eid" className={authLabel}>
              UT EID <span className="normal-case tracking-normal text-white/35">(optional)</span>
            </Label>
            <Input id="auth-eid" autoComplete="off" value={eid} onChange={(e) => setEid(e.target.value)} className={authInput} placeholder="e.g. abc123" />
          </div>
          <label htmlFor="auth-marketing" className="flex cursor-pointer items-center justify-between gap-4 border border-white/10 bg-white/[0.03] p-4">
            <span>
              <span className="block font-sans font-bold text-sm text-white">Club news and event emails</span>
              <span className="mt-0.5 block font-sans text-xs text-white/50">You can turn these off any time.</span>
            </span>
            <Switch id="auth-marketing" checked={marketing} onCheckedChange={(checked: boolean) => setMarketing(checked)} className="data-[state=checked]:bg-lsr-orange" />
          </label>
          {error && <AuthNotice tone="error">{error}</AuthNotice>}
          <Button type="submit" disabled={pending} className={authSubmit}>
            {pending ? "Creating your account…" : "Create account"}
          </Button>
          <p className="text-center font-sans text-sm text-white/55">
            Already a member?{" "}
            <button type="button" onClick={() => switchMode("signin")} className="font-bold text-lsr-orange hover:text-white">
              Sign in
            </button>
          </p>
        </form>
      )}
    </div>
  )
}
