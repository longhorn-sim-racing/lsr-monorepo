"use client";

import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleButton } from "@/components/google-button";
import { safeNextPath } from "@/lib/safe-redirect";
import Link from "next/link";

export default function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, startTransition] = useTransition();
  const supabase = createSupabaseBrowser();

  function onSignin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return alert(error.message);

      if (data.user && !data.user.email_confirmed_at) {
        return alert("Please verify your email before signing in.");
      }

      router.push(next);
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen bg-lsr-charcoal flex items-center justify-center p-4">
      <div className="w-full max-w-md border border-white/10 bg-white/[0.02] p-8 md:p-12 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-24 h-24 bg-lsr-orange/10 -rotate-45 translate-x-12 -translate-y-12" />
        
        <h1 className="font-display font-black italic text-4xl text-white uppercase tracking-normal mb-2 text-center leading-none">
          Welcome <span className="text-lsr-orange">Back</span>
        </h1>
        <p className="text-center text-white/40 font-sans font-bold uppercase tracking-widest text-[10px] mb-8">
            Authentication Required
        </p>
        
        <div className="grid gap-6">
          <GoogleButton next={searchParams.get("next") ? next : undefined} />
          
          <div className="relative my-3">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center">
              <span className="px-2 text-[10px] font-bold text-white/20 uppercase tracking-widest">OR</span>
            </div>
          </div>

          <form onSubmit={onSignin} className="grid gap-6">
            <div className="grid gap-2">
              <Label htmlFor="email" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Email Address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange text-white h-10 font-mono text-sm"
                placeholder="you@email.com"
                required
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="font-sans font-bold uppercase tracking-[0.2em] text-[9px] text-white/40">Password</Label>
                <Link
                  href="/auth/forgot-password"
                  className="font-sans font-bold text-[9px] text-lsr-orange uppercase tracking-widest hover:text-white transition-colors"
                >
                  Reset Password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-none border-white/10 bg-white/5 focus:border-lsr-orange focus:ring-lsr-orange text-white h-10 font-mono text-sm"
                placeholder="••••••••"
                required
              />
            </div>
            <Button type="submit" disabled={pending} className="w-full rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-black uppercase tracking-[0.2em] text-[10px] h-12 transition-all mt-2">
              Confirm Identity
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
