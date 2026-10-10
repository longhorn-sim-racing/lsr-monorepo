import Link from "next/link"
import { StatusScreen, statusPrimary, statusSecondary } from "@/components/status-screen"

export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      kicker="Page not found"
      title={
        <>
          Off <span className="text-lsr-orange">track</span>
        </>
      }
      photo="gallery/harris-hill-raceway/dsc00543"
      actions={
        <>
          <Link href="/" className={statusPrimary}>
            Back to the homepage
          </Link>
          <Link href="/events" className={statusSecondary}>
            See what&apos;s coming up
          </Link>
        </>
      }
    >
      That page doesn&apos;t exist, or it&apos;s moved. Rejoin from the homepage, or find your next event on the schedule.
    </StatusScreen>
  )
}
