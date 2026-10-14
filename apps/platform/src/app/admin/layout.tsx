import type { Metadata, Viewport } from "next"
import { cookies } from "next/headers"
import { ADMIN_THEME_COOKIE, parseAdminTheme } from "@/lib/admin-theme"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { AdminShell } from "@/components/admin/shell/admin-shell"

export const dynamic = "force-dynamic"

// Admin pages set a short title ("Events"); this makes the tab read "Events | LSR Admin"
export const metadata: Metadata = {
  title: { template: "%s | LSR Admin", default: "LSR Admin" },
  robots: { index: false, follow: false },
}

async function adminTheme() {
  return parseAdminTheme((await cookies()).get(ADMIN_THEME_COOKIE)?.value)
}

export async function generateViewport(): Promise<Viewport> {
  return { colorScheme: await adminTheme(), themeColor: "#1C1917" }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const officer = await requireOfficerPage()
  const { roles } = await getCachedSessionUser()
  const theme = await adminTheme()

  return (
    <AdminShell
      theme={theme}
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
