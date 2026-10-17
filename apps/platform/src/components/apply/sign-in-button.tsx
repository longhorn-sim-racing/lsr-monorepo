"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { primaryButton } from "./apply-styles";

/**
 * "Sign in to apply": opens the header's sign-in/create-account dialog and tells it where to send
 * the person afterwards. The link underneath is the same thing for anyone who prefers a page.
 */
export function SignInToApplyButton({ next = "/apply/start" }: { next?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button
        type="button"
        className={primaryButton}
        onClick={() => window.dispatchEvent(new CustomEvent("open-auth-dialog", { detail: { next } }))}
      >
        Sign in or create an account to apply
      </Button>
      <Link href={`/auth/signin?next=${encodeURIComponent(next)}`} className="font-sans text-xs font-bold uppercase tracking-widest text-white/60 underline-offset-4 hover:text-lsr-orange hover:underline">
        Use the sign-in page
      </Link>
    </div>
  );
}
