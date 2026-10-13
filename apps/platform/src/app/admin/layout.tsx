import type { Metadata, Viewport } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { AdminShell } from "@/components/admin/shell/admin-shell"

export const dynamic = "force-dynamic"

// Admin pages set a short title ("Events"); this makes the tab read "Events | LSR Admin"
export const metadata: Metadata = {
  title: { template: "%s | LSR Admin", default: "LSR Admin" },
  robots: { index: false, follow: false },
}

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
