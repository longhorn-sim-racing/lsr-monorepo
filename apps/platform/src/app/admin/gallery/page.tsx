import { getAllGalleryImages } from "@/server/queries/gallery";
import { GalleryAdminClient } from "@/app/admin/gallery/client";
import { requireOfficerPage } from "@/server/auth/guards";
import { prisma } from "@/server/db";

export default async function GalleryAdminPage() {
  await requireOfficerPage();
  const [images, albums, events] = await Promise.all([
    getAllGalleryImages(),
    prisma.galleryAlbum.findMany({
      orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    }),
    // For linking an album to an event
    prisma.event.findMany({
      select: { id: true, title: true, startsAtUtc: true },
      orderBy: { startsAtUtc: "desc" },
      take: 200,
    }),
  ]);

  return (
    <div className="h-full">
      <GalleryAdminClient
        images={images}
        albums={albums}
        events={events.map((event) => ({ id: event.id, title: event.title, date: event.startsAtUtc.toISOString() }))}
      />
    </div>
  );
}
