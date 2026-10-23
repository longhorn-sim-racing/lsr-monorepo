"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import type { GalleryAlbum, GalleryImage } from "@prisma/client"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core"
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from "@dnd-kit/sortable"
import { ExternalLink, FolderPlus, Settings2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button, EmptyState, Notice, PageHeader, Panel, PanelBody, PanelHeader, SearchInput, Toolbar, useConfirm } from "@/components/admin/kit"
import { createImage, deleteImage, moveImageToAlbum, updateImageOrder } from "@/app/admin/gallery/actions"
import { unexpectedError } from "@/lib/action-result"
import { JACK_GALLERY_PREFIX } from "@/lib/cloudinary"
import { CreditDialog } from "./_components/credit-dialog"
import { AlbumDialog, type EventOption } from "./_components/album-dialog"
import { AlbumSelect, AlbumSidebar, albumDate, type GalleryView } from "./_components/album-nav"
import { GalleryCard, SortableGalleryCard } from "./_components/gallery-card"

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function GalleryAdminClient({
  images: initialImages,
  albums: initialAlbums,
  events,
}: {
  images: GalleryImage[]
  albums: GalleryAlbum[]
  events: EventOption[]
}) {
  const confirm = useConfirm()
  const [images, setImages] = useState(initialImages)
  const [albums, setAlbums] = useState(initialAlbums)

  // Take the server's copy whenever the page re-renders after an action
  useEffect(() => {
    setImages(initialImages)
  }, [initialImages])
  useEffect(() => {
    setAlbums(initialAlbums)
  }, [initialAlbums])

  const [selectedView, setView] = useState<GalleryView>("all")
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null)
  const [search, setSearch] = useState("")
  const [editImage, setEditImage] = useState<GalleryImage | null>(null)
  const [albumDialog, setAlbumDialog] = useState<{ album: GalleryAlbum | null } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME!
  const preset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET!

  const currentAlbum = albums.find((album) => album.id === selectedView) ?? null
  // An album deleted elsewhere falls back to all photos
  const view: GalleryView = selectedView === "all" || selectedView === "unsorted" || currentAlbum ? selectedView : "all"
  const uploadAlbumId = view === "all" || view === "unsorted" ? null : view

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const viewImages = useMemo(() => {
    const inView = view === "all" ? images : images.filter((img) => (view === "unsorted" ? img.albumId === null : img.albumId === view))
    return [...inView].sort((a, b) => a.order - b.order)
  }, [images, view])

  const filteredImages = useMemo(() => {
    if (!search) return viewImages
    const q = search.toLowerCase()
    return viewImages.filter((img) => (img.alt || "").toLowerCase().includes(q) || (img.creditName || "").toLowerCase().includes(q))
  }, [viewImages, search])

  // Reordering only makes sense inside one album (or the unsorted pile), unfiltered
  const sortable = view !== "all" && !search

  const countFor = (albumId: string | null) => images.filter((img) => img.albumId === albumId).length
  const albumTitle = (albumId: string | null) => (albumId ? albums.find((album) => album.id === albumId)?.title ?? "the album" : "Unsorted")

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (files.length === 0) return

    setUpload({ done: 0, total: files.length })
    const failed: string[] = []
    for (const file of files) {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("upload_preset", preset)
      try {
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, { method: "POST", body: fd })
        const json = await res.json()
        if (!json.public_id) throw new Error(json.error?.message ?? "Upload failed")
        const newImage = await createImage(json.public_id, {
          albumId: uploadAlbumId,
          width: json.width ?? null,
          height: json.height ?? null,
        })
        setImages((prev) => [...prev, newImage])
      } catch (error) {
        console.error(error)
        failed.push(file.name)
      }
      setUpload((u) => (u ? { ...u, done: u.done + 1 } : u))
    }
    setUpload(null)
    const uploaded = files.length - failed.length
    if (uploaded > 0) toast.success(`Uploaded ${plural(uploaded, "photo")} to ${albumTitle(uploadAlbumId)}`)
    if (failed.length) toast.error(`These didn't upload: ${failed.join(", ")}`)
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = viewImages.findIndex((item) => item.id === active.id)
      const newIndex = viewImages.findIndex((item) => item.id === over.id)

      if (oldIndex !== -1 && newIndex !== -1) {
        const before = images
        const updates = arrayMove(viewImages, oldIndex, newIndex).map((img, index) => ({ id: img.id, order: index + 1 }))
        const orderById = new Map(updates.map((u) => [u.id, u.order]))
        setImages((prev) => prev.map((img) => (orderById.has(img.id) ? { ...img, order: orderById.get(img.id)! } : img)))

        startTransition(async () => {
          try {
            await updateImageOrder(updates)
          } catch (error) {
            setImages(before)
            toast.error(unexpectedError(error, "Couldn't save the new order"))
          }
        })
      }
    }

    setActiveId(null)
  }

  const handleDelete = async (image: GalleryImage) => {
    const ok = await confirm({
      tone: "danger",
      title: "Delete this photo?",
      // One Jack added loses its Cloudinary copy too, and a deck can use a gallery photo by its link
      description: image.publicId.startsWith(JACK_GALLERY_PREFIX)
        ? "It comes off the gallery, and its link stops working everywhere, including on deck slides that use it. This can't be undone."
        : "It comes off the gallery. This can't be undone.",
      confirmLabel: "Delete photo",
    })
    if (!ok) return

    // Optimistic delete
    setImages((prev) => prev.filter((img) => img.id !== image.id))
    startTransition(async () => {
      try {
        const result = await deleteImage(image.id)
        if (result.ok) toast.success("Photo deleted")
        else {
          // Its Cloudinary copy wouldn't delete, so it's still on the gallery
          setImages((prev) => [...prev, image])
          toast.error(result.error)
        }
      } catch (error) {
        setImages((prev) => [...prev, image])
        toast.error(unexpectedError(error, "Couldn't delete the photo"))
      }
    })
  }

  const handleMove = (image: GalleryImage, albumId: string | null) => {
    startTransition(async () => {
      try {
        const moved = await moveImageToAlbum(image.id, albumId)
        setImages((prev) => prev.map((img) => (img.id === image.id ? moved : img)))
        toast.success(`Moved to ${albumTitle(albumId)}`)
      } catch (error) {
        console.error(error)
        toast.error("Couldn't move that photo. Try again.")
      }
    })
  }

  const linkedEvent = currentAlbum?.eventId ? events.find((event) => event.id === currentAlbum.eventId) : undefined
  const viewCount = viewImages.length
  const heading =
    view === "all"
      ? { title: "All photos", description: `${plural(images.length, "photo")} across ${plural(albums.length, "album")}` }
      : view === "unsorted"
        ? { title: "Unsorted", description: `${plural(viewCount, "photo")} not in an album. /gallery shows them under Unsorted.` }
        : {
            title: currentAlbum!.title,
            description: [albumDate(currentAlbum!), plural(viewCount, "photo"), linkedEvent ? `Linked to ${linkedEvent.title}` : null].filter(Boolean).join(" · "),
          }

  const navProps = { view, onViewChange: setView, albums, total: images.length, countFor }
  const activeImage = activeId ? images.find((img) => img.id === activeId) : undefined

  return (
    <>
      <PageHeader
        title="Gallery"
        description={`${plural(images.length, "photo")} · ${plural(albums.length, "album")}`}
        actions={
          <>
            <Button onClick={() => setAlbumDialog({ album: null })}>
              <FolderPlus aria-hidden />
              New album
            </Button>
            <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
            <Button
              variant="primary"
              onClick={() => inputRef.current?.click()}
              pending={!!upload}
              disabled={view === "all"}
              title={view === "all" ? "Pick an album (or Unsorted) to upload into" : `Upload into ${albumTitle(uploadAlbumId)}`}
            >
              {!upload && <Upload aria-hidden />}
              {upload ? `Uploading ${upload.done + 1}/${upload.total}` : "Upload photos"}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <AlbumSidebar
          {...navProps}
          onNewAlbum={() => setAlbumDialog({ album: null })}
          className="hidden w-60 shrink-0 md:sticky md:top-[60px] md:flex md:max-h-[calc(100dvh-80px)]"
        />

        <Panel className="min-w-0 flex-1">
          <PanelHeader
            title={heading.title}
            description={heading.description}
            actions={
              currentAlbum && (
                <>
                  {viewCount > 0 && (
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/gallery?album=${currentAlbum.slug}`} target="_blank" rel="noreferrer">
                        <ExternalLink aria-hidden />
                        View on site
                      </Link>
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setAlbumDialog({ album: currentAlbum })}>
                    <Settings2 aria-hidden />
                    Album settings
                  </Button>
                </>
              )
            }
          />
          <PanelBody className="flex flex-col gap-3">
            <Toolbar className="mb-0">
              <AlbumSelect {...navProps} className="md:hidden" />
              <SearchInput value={search} onChange={setSearch} placeholder="Search by alt text or credit" />
            </Toolbar>

            {view === "all" && images.length > 0 && <Notice>Pick an album, or Unsorted, to upload into it or drag its photos into order.</Notice>}
            {view !== "all" && search && viewCount > 1 && <Notice>Clear the search to drag photos into order.</Notice>}

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              <SortableContext items={filteredImages} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
                  {filteredImages.map((image, index) => (
                    <SortableGalleryCard
                      key={image.id}
                      image={image}
                      position={view === "all" ? undefined : index + 1}
                      albums={albums}
                      sortable={sortable}
                      busy={isPending}
                      onDelete={handleDelete}
                      onMove={handleMove}
                      onEditCredit={setEditImage}
                    />
                  ))}
                </div>
              </SortableContext>

              <DragOverlay>
                {activeImage ? (
                  <GalleryCard
                    image={activeImage}
                    position={view === "all" ? undefined : filteredImages.findIndex((img) => img.id === activeImage.id) + 1}
                    albums={albums}
                    overlay
                  />
                ) : null}
              </DragOverlay>
            </DndContext>

            {filteredImages.length === 0 &&
              (search && viewCount > 0 ? (
                <EmptyState title="No photos match" description="Try a different search, or clear it to see every photo here." />
              ) : view === "all" ? (
                <EmptyState
                  title="No photos yet"
                  description="Pick Unsorted or an album, then upload photos into it."
                  action={<Button onClick={() => setView("unsorted")}>Go to Unsorted</Button>}
                />
              ) : (
                <EmptyState
                  title={view === "unsorted" ? "No unsorted photos" : "No photos in this album yet"}
                  description={view === "unsorted" ? "Every photo is in an album." : "Upload photos, or move photos here from another album."}
                  action={
                    <Button onClick={() => inputRef.current?.click()} disabled={!!upload}>
                      <Upload aria-hidden />
                      Upload photos
                    </Button>
                  }
                />
              ))}
          </PanelBody>
        </Panel>
      </div>

      {editImage && (
        <CreditDialog
          image={editImage}
          isOpen={!!editImage}
          onOpenChange={(open) => !open && setEditImage(null)}
          onSaved={(id, creditName, creditUrl) => setImages((prev) => prev.map((img) => (img.id === id ? { ...img, creditName, creditUrl } : img)))}
        />
      )}

      <AlbumDialog
        album={albumDialog?.album ?? null}
        events={events}
        photoCount={albumDialog?.album ? countFor(albumDialog.album.id) : 0}
        isOpen={albumDialog !== null}
        onOpenChange={(open) => !open && setAlbumDialog(null)}
        onSaved={(saved) => {
          setAlbums((prev) => (prev.some((a) => a.id === saved.id) ? prev.map((a) => (a.id === saved.id ? saved : a)) : [saved, ...prev]))
          setView(saved.id)
        }}
        onDeleted={(id) => {
          setAlbums((prev) => prev.filter((a) => a.id !== id))
          setImages((prev) => prev.map((img) => (img.albumId === id ? { ...img, albumId: null } : img)))
          setView("unsorted")
        }}
        onCreditApplied={(albumId, creditName, creditUrl) =>
          setImages((prev) => prev.map((img) => (img.albumId === albumId ? { ...img, creditName, creditUrl } : img)))
        }
      />
    </>
  )
}
