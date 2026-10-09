"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthForms, type AuthMode } from "@/components/auth/auth-forms";
import { safeNextPath } from "@/lib/safe-redirect";
import { AuthShell } from "../auth-shell";

export default function SignInPage() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const [mode, setMode] = useState<AuthMode>(searchParams.get("mode") === "signup" ? "signup" : "signin");
  const signup = mode === "signup";

  return (
    <AuthShell
      kicker={signup ? "New here" : "Members"}
      title={
        signup ? (
          <>
            Create your <span className="text-lsr-orange">account</span>
          </>
        ) : (
          <>
            Welcome <span className="text-lsr-orange">back</span>
          </>
        )
      }
      intro={
        signup
          ? "It takes a minute and it's free. You get a driver page and can register for anything on the calendar."
          : "Sign in to register for events, enter the Lone Star Cup and manage your driver page."
      }
    >
      <AuthForms initialMode={mode} next={next} googleNext={searchParams.get("next") ? next : undefined} onModeChange={setMode} />
    </AuthShell>
  );
}
