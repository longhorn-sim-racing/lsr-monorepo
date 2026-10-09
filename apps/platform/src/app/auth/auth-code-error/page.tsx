// src/app/auth/auth-code-error/page.tsx
import Link from 'next/link';

export default function AuthCodeErrorPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-lsr-charcoal text-white">
      <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16 ">
        <h1 className="text-4xl font-bold tracking-tight sm:text-[5rem]">
          Authentication Error
        </h1>
        <p className="text-lg text-center">
          The sign-in link may be invalid or expired.
          <br />
          Please try signing in again.
        </p>
        <Link
          href="/"
          className="rounded-md bg-lsr-orange px-4 py-2 text-lg text-lsr-charcoal-darker no-underline transition hover:bg-lsr-orange/80"
        >
          Go to Homepage
        </Link>
      </div>
    </div>
  );
}
