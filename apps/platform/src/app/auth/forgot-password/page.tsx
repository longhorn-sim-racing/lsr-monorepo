"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthNotice } from "@/components/auth/auth-forms"
import { authInput, authLabel, authSubmit } from "@/components/auth/auth-styles"
import { AuthShell } from "../auth-shell"
import { getSiteUrl } from "@/lib/site-url"

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [pending, startTransition] = useTransition()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState("")

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError("")
    startTransition(async () => {
      const supabase = createSupabaseBrowser()
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${getSiteUrl()}/auth/update-password`,
      })
      if (error) setError(error.message)
      else setSent(true)
    })
  }

  return (
    <AuthShell
      kicker="Account help"
      title={
        <>
          Forgot your <span className="text-lsr-orange">password?</span>
        </>
      }
      intro="Enter the email you signed up with and we'll send you a link to set a new one."
    >
      {sent ? (
        <AuthNotice tone="success">
          If there&apos;s an account for <span className="font-bold">{email}</span>, a reset link is on its way. It can take a minute; check spam too.
        </AuthNotice>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className={authLabel}>Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              disabled={pending}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@utexas.edu"
              required
              className={authInput}
            />
          </div>
          {error && <AuthNotice tone="error">{error}</AuthNotice>}
          <Button disabled={pending} className={authSubmit}>
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="mt-8 font-sans text-sm text-white/55">
        Remembered it?{" "}
        <Link href="/auth/signin" className="font-bold text-lsr-orange hover:text-white">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  )
}
