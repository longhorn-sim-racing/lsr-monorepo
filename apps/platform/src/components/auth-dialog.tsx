"use client"

import { createSupabaseBrowser } from "@/lib/supabase-browser";
import Link from "next/link";
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from "react"
import { useState, useTransition, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { GoogleButton } from "@/components/google-button"
import { safeNextPath } from "@/lib/safe-redirect"

type TabKey = "signin" | "signup"

export function AuthDialog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabKey>("signup")
  const [pending, startTransition] = useTransition()
  const supabase = createSupabaseBrowser()

  // shared
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  // signup-only
  const [displayName, setDisplayName] = useState("")
  const [eid, setEid] = useState("")
  const [marketing, setMarketing] = useState(true);

  // Where to send the user once they're signed in. A page can pass it when it opens the
  // dialog (`new CustomEvent("open-auth-dialog", { detail: { next: "/apply/start" } })`);
  // otherwise it comes from a `?next=` on the current URL (e.g. /auth/signin?next=...).
  // Only same-site paths survive safeNextPath; undefined means "stay where you are".
  const [nextOverride, setNextOverride] = useState<string | undefined>()
  const next = safeNextPath(nextOverride ?? searchParams?.get("next"), "") || undefined

  useEffect(() => {
    const handleOpen = (e: Event) => {
      setNextOverride((e as CustomEvent<{ next?: string } | undefined>).detail?.next)
      setOpen(true)
    }
    window.addEventListener("open-auth-dialog", handleOpen)
    return () => window.removeEventListener("open-auth-dialog", handleOpen)
  }, [])

  useEffect(() => {
    if (searchParams?.get("verified") === "true") {
      setOpen(true);
      setTab("signin");
      const msg = searchParams.get("message");
      if (msg) {
        // Use a small timeout to let the dialog open first or just alert
        setTimeout(() => alert(msg), 100);
      }
    }
  }, [searchParams]);

  function onSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const origin = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
      const redirectTo = `${origin.replace(/\/$/, '')}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ''}`;
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectTo,
          data: {
            displayName,
            eid,
            marketingOptIn: marketing,
          },
        },
      });
      if (error) {
        alert(error.message);
        return;
      }

      alert("Check your email to confirm and sign in.");
      setOpen(false);
    });
  }

  function onSignin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return alert(error.message);

      if (data.user && !data.user.email_confirmed_at) {
        return alert("Please verify your email before signing in.");
      }

      // Go where the user was headed (if anywhere), then refresh so Server Components
      // re-run with the new session
      if (next) router.push(next);
      router.refresh();
      setOpen(false);
    });
  }

  // Simple centered "OR" divider
  function OrDivider() {
    return (
      <div className="relative my-3">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-2 text-xs text-muted-foreground">OR</span>
        </div>
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) setNextOverride(undefined) // don't leak one page's destination into the next open
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" onClick={() => setTab("signup")} className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-9 px-3 md:px-6 transition-all">
          <span className="sm:hidden">Sign In</span>
          <span className="hidden sm:inline">Sign In / Create Account</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md w-[90%] h-full max-h-[95vh] md:max-h-[90vh] overflow-y-auto rounded-none bg-lsr-charcoal border-white/10 p-0 shadow-2xl">
        <div className="flex flex-col min-h-full">
          <DialogHeader className="p-8 pb-0 shrink-0">
            <DialogTitle className="font-display font-black italic text-3xl text-white uppercase tracking-normal">
              {tab === "signup" ? "Join the" : "Welcome"} <span className="text-lsr-orange">{tab === "signup" ? "Grid" : "Back"}</span>
            </DialogTitle>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v: string) => setTab((v as TabKey) ?? "signup")}
            className="p-8 pt-6 flex-grow flex flex-col"
          >
            <TabsList className="grid w-full grid-cols-2 bg-white/5 rounded-none p-1 h-12 shrink-0">
              <TabsTrigger value="signup" className="rounded-none font-sans font-bold uppercase tracking-widest text-[10px] data-[state=active]:bg-lsr-orange data-[state=active]:text-white transition-all">Create Account</TabsTrigger>
              <TabsTrigger value="signin" className="rounded-none font-sans font-bold uppercase tracking-widest text-[10px] data-[state=active]:bg-lsr-orange data-[state=active]:text-white transition-all">Sign In</TabsTrigger>
            </TabsList>

            {/* ---------- SIGN UP ---------- */}
            <TabsContent value="signup" className="mt-8 outline-none flex-grow">
            <div className="grid gap-6">
              {/* Google first */}
              <GoogleButton next={next} />

              <OrDivider />

              {/* Email/password form */}
              <form onSubmit={onSignup} className="grid gap-6">
                <div className="grid gap-2">
                  <Label htmlFor="name" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Full Name</Label>
                  <Input
                    id="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange transition-all"
                    placeholder="Enter your name"
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="email" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange transition-all"
                    placeholder="you@email.com"
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="password" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange transition-all"
                    placeholder="••••••••"
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="eid" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">UT EID / Student ID</Label>
                  <Input
                    id="eid"
                    value={eid}
                    onChange={(e) => setEid(e.target.value)}
                    className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange transition-all"
                    placeholder="e.g., abc123"
                  />
                </div>

                <div className="flex items-center justify-between border border-white/10 bg-white/[0.02] p-4">
                  <div className="space-y-1">
                    <div className="font-sans font-bold uppercase tracking-widest text-[9px] text-white">Marketing Updates</div>
                    <p className="font-sans text-[9px] text-white/30 uppercase tracking-tight">
                      News & event notifications.
                    </p>
                  </div>
                  <Switch
                    checked={marketing}
                    onCheckedChange={(checked: boolean) => setMarketing(checked)}
                    className="data-[state=checked]:bg-lsr-orange"
                  />
                </div>

                <Button type="submit" disabled={pending} className="w-full rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-black uppercase tracking-[0.2em] text-[10px] h-12 transition-all">
                  Initialize Account
                </Button>
              </form>
            </div>
          </TabsContent>

          {/* ---------- SIGN IN ---------- */}
          <TabsContent value="signin" className="mt-8 outline-none">
            <div className="grid gap-6">
              {/* Google first */}
              <GoogleButton next={next} />

              <OrDivider />

              {/* Email/password form */}
              <form onSubmit={onSignin} className="grid gap-6">
                <div className="grid gap-2">
                  <Label htmlFor="email2" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Email Address</Label>
                  <Input
                    id="email2"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange transition-all"
                    placeholder="you@email.com"
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password2" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Password</Label>
                    <Link
                      href="/auth/forgot-password"
                      className="font-sans font-bold text-[9px] text-lsr-orange uppercase tracking-widest hover:text-white transition-colors"
                      onClick={() => setOpen(false)}
                    >
                      Reset Password?
                    </Link>
                  </div>
                  <Input
                    id="password2"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange transition-all"
                    placeholder="••••••••"
                    required
                  />
                </div>

                <Button type="submit" disabled={pending} className="w-full rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-black uppercase tracking-[0.2em] text-[10px] h-12 transition-all">
                  Confirm Identity
                </Button>
              </form>
            </div>
          </TabsContent>
        </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  )
}