import { redirect } from "next/navigation"
import { requireOfficer } from "@/server/auth/guards"
import { AdminSidebar } from "@/components/admin/admin-sidebar"

export const dynamic = "force-dynamic"

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireOfficer();
  } catch {
    redirect("/403");
  }
  return (
    <div className="flex min-h-screen">
      <AdminSidebar />
      <div className="flex-1 p-6 overflow-x-hidden">
        {children}
      </div>
    </div>
  )
}
