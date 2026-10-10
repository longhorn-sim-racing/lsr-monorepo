'use client';

import { useEffect, useState, useTransition } from 'react';
import type { GalleryAlbum } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createAlbum, deleteAlbum, setAlbumCredit, updateAlbum } from '@/app/admin/gallery/actions';

export type EventOption = { id: string; title: string; date: string };

const fieldClass = 'bg-black/50 border-white/10 text-white';

export function AlbumDialog({
  album,
  events,
  isOpen,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  /** Edit this album, or create a new one when null */
  album: GalleryAlbum | null;
  events: EventOption[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (album: GalleryAlbum) => void;
  onDeleted: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [eventId, setEventId] = useState('');
  const [creditName, setCreditName] = useState('');
  const [creditUrl, setCreditUrl] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!isOpen) return;
    setTitle(album?.title ?? '');
    setDate(album?.date ? new Date(album.date).toISOString().slice(0, 10) : '');
    setDescription(album?.description ?? '');
    setEventId(album?.eventId ?? '');
    setCreditName('');
    setCreditUrl('');
    setMessage(null);
  }, [isOpen, album]);

  const input = () => ({ title, date: date || null, description: description || null, eventId: eventId || null });

  const save = () =>
    startTransition(async () => {
      try {
        const saved = album ? await updateAlbum(album.id, input()) : await createAlbum(input());
        onSaved(saved);
        onOpenChange(false);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not save the album');
      }
    });

  const applyCredit = () =>
    album &&
    startTransition(async () => {
      try {
        const count = await setAlbumCredit(album.id, creditName || null, creditUrl || null);
        setMessage(`Credit set on ${count} photo${count === 1 ? '' : 's'}.`);
      } catch {
        setMessage('Could not set the credit. Try again.');
      }
    });

  const remove = () =>
    album &&
    window.confirm(`Delete "${album.title}"? Its photos stay in the gallery as unsorted.`) &&
    startTransition(async () => {
      try {
        await deleteAlbum(album.id);
        onDeleted(album.id);
        onOpenChange(false);
      } catch {
        setMessage('Could not delete the album. Try again.');
      }
    });

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-950 border-white/10 text-white sm:max-w-lg font-mono">
        <DialogHeader>
          <DialogTitle>{album ? 'Edit album' : 'New album'}</DialogTitle>
          <DialogDescription className="text-white/50">
            Albums group photos from one shoot or event. They show newest first on /gallery.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="album-title">Title</Label>
            <Input id="album-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="LSC Season 3: Round 4" className={fieldClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="album-date">Date taken</Label>
              <Input id="album-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="album-event">Linked event</Label>
              <select
                id="album-event"
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="h-9 rounded-md border border-white/10 bg-black/50 px-2 text-xs text-white"
              >
                <option value="">None</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.date.slice(0, 10)} · {event.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="album-description">Description (optional)</Label>
            <Textarea id="album-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={fieldClass} />
          </div>

          {album && (
            <div className="grid gap-2 border-t border-white/10 pt-4">
              <Label>Photo credit for every photo in this album</Label>
              <div className="flex gap-2">
                <Input value={creditName} onChange={(e) => setCreditName(e.target.value)} placeholder="Photographer" className={fieldClass} />
                <Input value={creditUrl} onChange={(e) => setCreditUrl(e.target.value)} placeholder="Link (optional)" className={fieldClass} />
                <Button type="button" variant="outline" onClick={applyCredit} disabled={isPending || !creditName.trim()} className="border-white/15 bg-transparent">
                  Apply
                </Button>
              </div>
            </div>
          )}

          {message && <p className="text-xs text-lsr-orange">{message}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {album ? (
            <Button type="button" variant="ghost" onClick={remove} disabled={isPending} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
              Delete album
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={save} disabled={isPending || !title.trim()} className="bg-lsr-orange hover:bg-lsr-orange/90 text-white">
            {album ? 'Save' : 'Create album'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
