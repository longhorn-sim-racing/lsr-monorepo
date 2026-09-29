'use client';

import { useRef, useState, useTransition, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { createImage, deleteImage, updateImageOrder } from '@/app/admin/gallery/actions';
import { GalleryImage } from '@prisma/client';
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
import { Image as ImageIcon, Search, Plus, Trash2, Edit, GripVertical, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// --- Sortable Item Component ---
function SortableGalleryItem({
  image,
  index,
  isOverlay = false,
  onDelete,
  cloudName,
  isPending,
  onEditCredit
}: {
  image: GalleryImage;
  index: number;
  isOverlay?: boolean;
  onDelete?: (id: string) => void;
  cloudName: string;
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
  } = useSortable({ id: image.id });

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
        {!isOverlay && (
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
              src={`https://res.cloudinary.com/${cloudName}/image/upload/w_400,h_300,c_fill,q_auto/${image.publicId}`}
              alt={image.alt ?? image.creditName ?? 'Gallery image'}
              fill
              className="object-cover pointer-events-none"
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        </div>

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
export function GalleryAdminClient({ images: initialImages }: { images: GalleryImage[] }) {
  const [images, setImages] = useState(initialImages);
  
  // Sync state when props change
  useEffect(() => {
    setImages(initialImages);
  }, [initialImages]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isUploading, setIsUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [editImage, setEditImage] = useState<GalleryImage | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET!;

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

  const filteredImages = useMemo(() => {
      if (!search) return images;
      const q = search.toLowerCase();
      return images.filter(img => 
          (img.alt || "").toLowerCase().includes(q) ||
          (img.creditName || "").toLowerCase().includes(q)
      );
  }, [images, search]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', preset);

    try {
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, {
            method: 'POST',
            body: fd,
        });
        const json = await res.json();
        if (!json.public_id) {
            alert('Upload failed.');
            return;
        }

        startTransition(async () => {
            const newImage = await createImage(json.public_id);
            if (newImage) {
                // Optimistic update
                setImages((prev) => [...prev, newImage]);
            }
        });
    } catch (e) {
        console.error(e);
        alert('Upload error');
    } finally {
        setIsUploading(false);
    }
  }

  function chooseFile() {
    inputRef.current?.click();
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = images.findIndex((item) => item.id === active.id);
      const newIndex = images.findIndex((item) => item.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = arrayMove(images, oldIndex, newIndex);
          setImages(newOrder);

          // Server action
          startTransition(async () => {
              const updates = newOrder.map((img, index) => ({
                  id: img.id,
                  order: index + 1
              }));
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

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] border border-white/10 bg-black/40 rounded-lg overflow-hidden font-mono text-sm">
      {/* Toolbar */}
      <div className="bg-white/5 p-3 border-b border-white/10 flex items-center gap-4 flex-wrap">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded border border-white/10 cursor-help">
                <ImageIcon size={14} className="text-lsr-orange" />
                <span className="font-bold text-white/80 tracking-wider uppercase">Gallery</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs bg-black/90 border-white/10 text-white p-3">
              <p className="font-bold mb-1 text-lsr-orange">Gallery Console</p>
              <p className="text-xs text-white/80">
                Manage images shown on the public gallery. Drag to reorder.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="h-6 w-px bg-white/10 mx-2" />

        <div className="flex items-center gap-2 relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 text-white/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by alt or credit..."
            className="w-full bg-black/50 border border-white/10 rounded pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-lsr-orange transition-colors"
          />
        </div>

        <div className="flex-1" />

        <input ref={inputRef} type="file" accept="image/*" hidden onChange={onFile} />
        <Button 
            size="sm" 
            onClick={chooseFile} 
            disabled={isUploading || isPending}
            className="bg-lsr-orange hover:bg-lsr-orange/90 text-white border-0 font-bold uppercase tracking-wider text-xs h-8"
        >
          {isUploading ? (
              <>
                <Loader2 size={14} className="mr-2 animate-spin" /> Uploading...
              </>
          ) : (
              <>
                <Plus size={14} className="mr-2" /> Upload Image
              </>
          )}
        </Button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto p-4">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={images} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {filteredImages.map((image, index) => (
                  <SortableGalleryItem
                    key={image.id}
                    image={image}
                    index={index}
                    cloudName={cloudName}
                    onDelete={handleDelete}
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
                  index={images.findIndex((i) => i.id === activeId)}
                  isOverlay
                  cloudName={cloudName}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
      </div>
      
      {editImage && (
        <CreditDialog 
            image={editImage} 
            isOpen={!!editImage} 
            onOpenChange={(open) => !open && setEditImage(null)} 
        />
      )}
    </div>
  );
}
