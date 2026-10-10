import Link from "next/link";
import { Button } from "@/components/ui/button";
import { authSubmit } from "@/components/auth/auth-styles";
import { AuthShell } from "../auth-shell";

export default function AuthCodeErrorPage() {
  return (
    <AuthShell
      kicker="Sign-in problem"
      title={
        <>
          That link <span className="text-lsr-orange">didn&apos;t work</span>
        </>
      }
      intro="Sign-in and confirmation links only work once, and they expire after a while. Try signing in; if you've lost your password, reset it."
    >
      <div className="space-y-3">
        <Button asChild className={authSubmit}>
          <Link href="/auth/signin">Sign in</Link>
        </Button>
        <Button asChild className="h-12 w-full rounded-none border border-white/20 bg-transparent font-sans text-xs font-bold uppercase tracking-[0.2em] text-white hover:bg-white hover:text-lsr-charcoal">
          <Link href="/auth/forgot-password">Reset my password</Link>
        </Button>
      </div>
      <p className="mt-8 font-sans text-sm text-white/55">
        Still stuck? Email{" "}
        <a href="mailto:info@longhornsimracing.org" className="font-bold text-lsr-orange hover:text-white">
          info@longhornsimracing.org
        </a>
        .
      </p>
    </AuthShell>
  );
}
