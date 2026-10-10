// src/components/google-button.tsx
"use client"

import { Button } from "@/components/ui/button"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { siGoogle } from "simple-icons/icons" // tree-shaken import
import { getSiteUrl } from "@/lib/site-url"

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className={className}
      role="img"
    >
      <title>Google</title>
      {/* simple-icons is single-path; use brand color or inherit currentColor */}
      <path d={siGoogle.path} fill="currentColor" />
    </svg>
  )
}

export function GoogleButton({ next }: { next?: string }) {
  const handle = async () => {
    const supabase = createSupabaseBrowser();
    const redirectTo = `${getSiteUrl()}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
  };

  return (
    <Button
      type="button"
      onClick={handle}
      variant="outline"
      className="h-11 w-full rounded-none border-white/15 bg-white/[0.04] font-sans text-sm font-bold text-white hover:border-white/40 hover:bg-white/10 hover:text-white"
    >
      <GoogleIcon className="mr-2 h-4 w-4" />
      Continue with Google
    </Button>
  )
}
