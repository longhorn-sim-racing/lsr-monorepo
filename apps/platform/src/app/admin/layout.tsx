import type { Viewport } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { AdminShell } from "@/components/admin/shell/admin-shell"

export const dynamic = "force-dynamic"

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#1C1917",
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const officer = await requireOfficerPage()
  const { roles } = await getCachedSessionUser()

  return (
    <AdminShell
      user={{
        displayName: officer.displayName,
        avatarUrl: officer.avatarUrl,
        roleLabel: roles.includes("admin") ? "Admin" : "Officer",
      }}
    >
      {children}
    </AdminShell>
  )
}
