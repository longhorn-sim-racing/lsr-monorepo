import Link from "next/link"
import type { Metadata } from "next"
import { StatusScreen, statusPrimary, statusSecondary } from "@/components/status-screen"

export const metadata: Metadata = {
  title: "Officers only",
  robots: { index: false },
}

export default function Forbidden() {
  return (
    <StatusScreen
      code="403"
      kicker="Officers only"
      title={
        <>
          Pit lane <span className="text-lsr-orange">closed</span>
        </>
      }
      photo="gallery/wec-at-cota-2025/dsc09812"
      actions={
        <>
          <Link href="/" className={statusPrimary}>
            Back to the homepage
          </Link>
          <Link href="/account" className={statusSecondary}>
            Your account
          </Link>
        </>
      }
    >
      This part of the site is for LSR officers. If you&apos;re an officer and still seeing this, ask the tech team to check your role.
    </StatusScreen>
  )
}
