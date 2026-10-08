'use client';

import { useRef, useState, useTransition, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { createImage, deleteImage, moveImageToAlbum, updateImageOrder } from '@/app/admin/gallery/actions';
import type { GalleryAlbum, GalleryImage } from '@prisma/client';
import Image from 'next/image';
import { ConfirmSubmitButton } from '@/components/confirm-submit-button';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CreditDialog } from './_components/credit-dialog';
import { AlbumDialog, type EventOption } from './_components/album-dialog';
import { Image as ImageIcon, Search, Plus, Trash2, Edit, GripVertical, Loader2, FolderPlus, Settings2 } from 'lucide-react';
import { cloudinaryUrl } from '@/lib/cloudinary';
import { cn } from "@/lib/utils";

/** Which photos are showing: everything, the unsorted ones, or one album (by id). */
type View = 'all' | 'unsorted' | string;

// --- Sortable Item Component ---
function SortableGalleryItem({
  image,
  index,
  albums,
  isOverlay = false,
  sortable = true,
  onDelete,
  onMove,
  isPending,
  onEditCredit
}: {
  image: GalleryImage;
  index: number;
  albums: GalleryAlbum[];
  isOverlay?: boolean;
  sortable?: boolean;
  onDelete?: (id: string) => void;
  onMove?: (id: string, albumId: string | null) => void;
  isPending?: boolean;
  onEditCredit?: (image: GalleryImage) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id, disabled: !sortable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    zIndex: isDragging ? 999 : 'auto',
  };

  const content = (
      <div className={cn(
          "relative group bg-white/5 rounded border border-white/10 overflow-hidden flex flex-col",
          isOverlay ? "shadow-2xl scale-105 border-lsr-orange/50 cursor-grabbing" : "hover:border-white/30"
      )}>
        {/* Order Badge */}
        <div className="absolute top-2 left-2 z-20 bg-black/80 text-white/80 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border border-white/10 pointer-events-none">
          #{index + 1}
        </div>

        {/* Drag Handle */}
        {!isOverlay && sortable && (
            <div
                {...attributes}
                {...listeners}
                className="absolute top-2 right-2 z-20 p-1.5 bg-black/60 text-white/60 hover:text-white rounded cursor-grab active:cursor-grabbing hover:bg-black/80 transition-colors"
            >
              <GripVertical size={14} />
            </div>
        )}

        {/* Image */}
        <div className="relative aspect-video w-full bg-black/20">
          <Image
              src={cloudinaryUrl(image.publicId, { width: 400, height: 300, crop: 'fill' })}
              alt={image.alt ?? image.creditName ?? 'Gallery image'}
              fill
              unoptimized
              className="object-cover pointer-events-none"
          />
        </div>

        {/* Album */}
        {onMove && (
          <select
            value={image.albumId ?? ''}
            onChange={(e) => onMove(image.id, e.target.value || null)}
            disabled={isPending}
            className="w-full border-t border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-white/70 focus:outline-none"
            aria-label="Album"
          >
            <option value="">Unsorted</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>{album.title}</option>
            ))}
          </select>
        )}

        {/* Footer Info */}
        <div className="p-2 border-t border-white/10 bg-white/5 flex items-center justify-between gap-2 h-10">
           <div className="flex-1 min-w-0 flex flex-col justify-center">
             {image.creditName ? (
                 <span className="text-[10px] text-white/60 truncate block font-mono">
                   © {image.creditName}
                 </span>
             ) : (
                 <span className="text-[10px] text-white/20 italic truncate block font-mono">
                   No credit
                 </span>
             )}
           </div>

           <div className="flex items-center gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
               {onEditCredit && (
                   <Button
                       size="icon"
                       variant="ghost"
                       className="h-6 w-6 text-white/40 hover:text-lsr-orange hover:bg-white/10"
                       onClick={() => onEditCredit(image)}
                       title="Edit Credit"
                   >
                       <Edit size={12} />
                   </Button>
               )}
               {onDelete && (
                    <form
                       action={() => onDelete(image.id)}
                    >
                       <ConfirmSubmitButton
                           size="icon"
                           variant="ghost"
                           className="h-6 w-6 text-white/40 hover:text-red-400 hover:bg-white/10"
                           message="Delete this image? This cannot be undone."
                           disabled={isPending}
                           title="Delete"
                       >
                           <Trash2 size={12} />
                       </ConfirmSubmitButton>
                   </form>
               )}
           </div>
        </div>
      </div>
  );

  if (isOverlay) {
      return content;
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative touch-none"
    >
        {content}
    </div>
  );
}

// --- Main Client Component ---
export function GalleryAdminClient({
  images: initialImages,
  albums: initialAlbums,
  events,
}: {
  images: GalleryImage[];
  albums: GalleryAlbum[];
  events: EventOption[];
}) {
  const [images, setImages] = useState(initialImages);
  const [albums, setAlbums] = useState(initialAlbums);

  // Sync state when props change
  useEffect(() => {
    setImages(initialImages);
  }, [initialImages]);
  useEffect(() => {
    setAlbums(initialAlbums);
  }, [initialAlbums]);

  const [view, setView] = useState<View>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [search, setSearch] = useState("");
  const [editImage, setEditImage] = useState<GalleryImage | null>(null);
  const [albumDialog, setAlbumDialog] = useState<{ album: GalleryAlbum | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET!;

  const currentAlbum = albums.find((album) => album.id === view) ?? null;
  const uploadAlbumId = view === 'all' || view === 'unsorted' ? null : view;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const viewImages = useMemo(() => {
    const inView =
      view === 'all' ? images : images.filter((img) => (view === 'unsorted' ? img.albumId === null : img.albumId === view));
    return [...inView].sort((a, b) => a.order - b.order);
  }, [images, view]);

  const filteredImages = useMemo(() => {
      if (!search) return viewImages;
      const q = search.toLowerCase();
      return viewImages.filter(img =>
          (img.alt || "").toLowerCase().includes(q) ||
          (img.creditName || "").toLowerCase().includes(q)
      );
  }, [viewImages, search]);

  // Reordering only makes sense inside one album (or the unsorted pile), unfiltered
  const sortable = view !== 'all' && !search;

  const countFor = (albumId: string | null) => images.filter((img) => img.albumId === albumId).length;

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setUpload({ done: 0, total: files.length });
    const failed: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', preset);
      try {
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, { method: 'POST', body: fd });
        const json = await res.json();
        if (!json.public_id) throw new Error(json.error?.message ?? 'Upload failed');
        const newImage = await createImage(json.public_id, {
          albumId: uploadAlbumId,
          width: json.width ?? null,
          height: json.height ?? null,
        });
        setImages((prev) => [...prev, newImage]);
      } catch (error) {
        console.error(error);
        failed.push(file.name);
      }
      setUpload((u) => (u ? { ...u, done: u.done + 1 } : u));
    }
    setUpload(null);
    if (failed.length) alert(`These didn't upload: ${failed.join(', ')}`);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = viewImages.findIndex((item) => item.id === active.id);
      const newIndex = viewImages.findIndex((item) => item.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
          const updates = arrayMove(viewImages, oldIndex, newIndex).map((img, index) => ({
              id: img.id,
              order: index + 1
          }));
          const orderById = new Map(updates.map((u) => [u.id, u.order]));
          setImages((prev) => prev.map((img) => (orderById.has(img.id) ? { ...img, order: orderById.get(img.id)! } : img)));

          // Server action
          startTransition(async () => {
              await updateImageOrder(updates);
          });
      }
    }

    setActiveId(null);
  }

  const handleDelete = (id: string) => {
      // Optimistic delete
      setImages((prev) => prev.filter((img) => img.id !== id));

      startTransition(async () => {
          await deleteImage(id);
      });
  }

  const handleMove = (id: string, albumId: string | null) => {
      startTransition(async () => {
          try {
              const moved = await moveImageToAlbum(id, albumId);
              setImages((prev) => prev.map((img) => (img.id === id ? moved : img)));
          } catch (error) {
              console.error(error);
              alert("Couldn't move that photo. Try again.");
          }
      });
  }

  const navItem = (key: View, label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setView(key)}
      className={cn(
        "w-full flex items-center justify-between gap-2 px-3 py-2 rounded text-left text-xs transition-colors",
        view === key ? "bg-lsr-orange/15 text-white border border-lsr-orange/40" : "text-white/60 hover:text-white hover:bg-white/5 border border-transparent"
      )}
    >
      <span className="truncate">{label}</span>
      <span className="text-[10px] text-white/40">{count}</span>
    </button>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
      {/* Toolbar */}
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10">
          <ImageIcon size={14} className="text-lsr-orange" />
          <span className="font-bold text-white/80 tracking-wider uppercase">Gallery</span>
        </div>

        {/* Album picker on small screens */}
        <select
          value={view}
          onChange={(e) => setView(e.target.value)}
          className="md:hidden bg-black/50 border border-white/10 rounded px-2 py-1.5 text-xs text-white"
          aria-label="Album"
        >
          <option value="all">All photos ({images.length})</option>
          <option value="unsorted">Unsorted ({countFor(null)})</option>
          {albums.map((album) => (
            <option key={album.id} value={album.id}>{album.title} ({countFor(album.id)})</option>
          ))}
        </select>

        <div className="flex items-center gap-2 relative flex-1 min-w-[10rem] max-w-md">
          <Search size={14} className="absolute left-3 text-white/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by alt or credit..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="flex-1" />

        {currentAlbum && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAlbumDialog({ album: currentAlbum })}
            className="border-white/15 bg-transparent text-white/80 font-bold uppercase tracking-wider text-xs h-8"
          >
            <Settings2 size={14} className="mr-2" /> Album settings
          </Button>
        )}

        <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
        <Button
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={!!upload || view === 'all'}
            title={view === 'all' ? 'Pick an album (or Unsorted) to upload into' : undefined}
            className="bg-lsr-orange hover:bg-lsr-orange/90 text-white border-0 font-bold uppercase tracking-wider text-xs h-8"
        >
          {upload ? (
              <>
                <Loader2 size={14} className="mr-2 animate-spin" /> Uploading {upload.done + 1}/{upload.total}
              </>
          ) : (
              <>
                <Plus size={14} className="mr-2" /> Upload photos
              </>
          )}
        </Button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Albums */}
        <aside className="hidden md:flex w-60 shrink-0 flex-col gap-1 border-r border-white/10 p-3 overflow-auto">
          {navItem('all', 'All photos', images.length)}
          {navItem('unsorted', 'Unsorted', countFor(null))}
          <div className="mt-3 mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Albums</span>
            <button
              type="button"
              onClick={() => setAlbumDialog({ album: null })}
              className="text-white/50 hover:text-lsr-orange transition-colors"
              title="New album"
            >
              <FolderPlus size={14} />
            </button>
          </div>
          {albums.map((album) => navItem(album.id, album.title, countFor(album.id)))}
          {albums.length === 0 && <p className="px-3 text-[10px] text-white/30">No albums yet</p>}
        </aside>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-4">
          {view === 'all' && images.length > 0 && (
            <p className="mb-3 text-[10px] text-white/40">Pick an album to upload into it or reorder its photos.</p>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={filteredImages} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {filteredImages.map((image, index) => (
                  <SortableGalleryItem
                    key={image.id}
                    image={image}
                    index={index}
                    albums={albums}
                    sortable={sortable}
                    onDelete={handleDelete}
                    onMove={handleMove}
                    isPending={isPending}
                    onEditCredit={setEditImage}
                  />
                ))}
              </div>
            </SortableContext>

            <DragOverlay>
              {activeId ? (
                <SortableGalleryItem
                  image={images.find((i) => i.id === activeId)!}
                  index={filteredImages.findIndex((i) => i.id === activeId)}
                  albums={albums}
                  isOverlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
          {filteredImages.length === 0 && (
            <p className="py-16 text-center text-xs text-white/30">No photos here yet.</p>
          )}
        </div>
      </div>

      {editImage && (
        <CreditDialog
            image={editImage}
            isOpen={!!editImage}
            onOpenChange={(open) => !open && setEditImage(null)}
        />
      )}

      <AlbumDialog
        album={albumDialog?.album ?? null}
        events={events}
        isOpen={albumDialog !== null}
        onOpenChange={(open) => !open && setAlbumDialog(null)}
        onSaved={(saved) => {
          setAlbums((prev) => (prev.some((a) => a.id === saved.id) ? prev.map((a) => (a.id === saved.id ? saved : a)) : [saved, ...prev]));
          setView(saved.id);
        }}
        onDeleted={(id) => {
          setAlbums((prev) => prev.filter((a) => a.id !== id));
          setImages((prev) => prev.map((img) => (img.albumId === id ? { ...img, albumId: null } : img)));
          setView('unsorted');
        }}
      />
    </div>
  );
}
