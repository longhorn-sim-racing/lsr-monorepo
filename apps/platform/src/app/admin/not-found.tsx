import Link from "next/link"
import { Button } from "@/components/admin/kit/button"
import { EmptyState, Panel } from "@/components/admin/kit/surface"

// Shown inside the admin shell when an admin page can't find what it was asked for (an old link, a deleted item)
export default function AdminNotFound() {
  return (
    <Panel className="mx-auto mt-10 max-w-xl">
      <EmptyState
        title="That page or item doesn't exist"
        description="It may have been deleted, or the link is out of date. Pick a section from the sidebar, or go back to the overview."
        action={
          <Button asChild variant="primary">
            <Link href="/admin">Admin overview</Link>
          </Button>
        }
      />
    </Panel>
  )
}
