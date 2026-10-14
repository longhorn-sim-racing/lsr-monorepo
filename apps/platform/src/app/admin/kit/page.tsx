import { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { KitGallery } from "./gallery"

export const metadata: Metadata = {
  title: "Admin kit",
}

export default async function AdminKitPage() {
  await requireOfficerPage()
  return <KitGallery />
}
