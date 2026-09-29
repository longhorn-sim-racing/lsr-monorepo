import { getAllGalleryImages } from "@/server/queries/gallery";
import { GalleryAdminClient } from "@/app/admin/gallery/client";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function GalleryAdminPage() {
  await requireOfficerPage();
  const images = await getAllGalleryImages();

  return (
    <div className="h-full">
      <GalleryAdminClient images={images} />
    </div>
  );
}
