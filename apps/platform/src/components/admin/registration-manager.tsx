"use client";

import { useState } from "react";
import { User, EventRegistration } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  overrideRegistrationStatus,
  removeRegistration,
  reorderWaitlist,
} from "@/app/admin/events/actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  DndContext, 
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type RegistrationWithUser = EventRegistration & { user: User };

function SortableItem({ id, children }: { id: string; children: React.ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

export function RegistrationManager({ eventId, registrations }: { eventId: string, registrations: RegistrationWithUser[] }) {
  const registered = registrations.filter(r => r.status === "REGISTERED");
  const waitlisted = registrations.filter(r => r.status === "WAITLISTED").sort((a, b) => (a.waitlistOrder ?? 0) - (b.waitlistOrder ?? 0));
  const notAttending = registrations.filter(r => r.status === "NOT_ATTENDING");

  const [waitlistIds, setWaitlistIds] = useState(waitlisted.map(r => r.id));

  // Sync state if props change (revalidation)
  if (JSON.stringify(waitlisted.map(r => r.id)) !== JSON.stringify(waitlistIds) && !document.activeElement?.getAttribute('aria-roledescription')) {
      // Very basic check to avoid resetting while dragging, ideally use useEffect
      // setWaitlistIds(waitlisted.map(r => r.id));
  }

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

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = waitlistIds.indexOf(active.id as string);
      const newIndex = waitlistIds.indexOf(over.id as string);
      const newOrder = arrayMove(waitlistIds, oldIndex, newIndex);
      
      setWaitlistIds(newOrder);
      await reorderWaitlist(eventId, newOrder);
    }
  };

  return (
    <div className="space-y-8 mt-8 border-t pt-8">
      <h2 className="text-2xl font-bold">Manage Registration</h2>

      {/* REGISTERED */}
      <div>
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
          Registered <Badge>{registered.length}</Badge>
        </h3>
        <div className="grid gap-2">
          {registered.map(reg => (
            <div key={reg.id} className="flex items-center justify-between p-3 border rounded-md bg-green-500/5">
              <div className="flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={reg.user.avatarUrl || undefined} />
                  <AvatarFallback>{reg.user.displayName[0]}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-bold">{reg.user.displayName}</div>
                  <div className="text-xs text-muted-foreground flex gap-2">
                    {reg.promotionSource === "AUTO" && <Badge variant="secondary" className="text-[10px]">Auto-Promoted</Badge>}
                    {reg.promotionSource === "ADMIN" && <Badge variant="destructive" className="text-[10px]">Admin-Promoted</Badge>}
                    <span>{new Date(reg.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => overrideRegistrationStatus(eventId, reg.user.id, "WAITLISTED", "Admin demote")}
                >
                  To Waitlist
                </Button>
                <Button 
                  size="sm" 
                  variant="ghost" 
                  className="text-red-500"
                  onClick={() => removeRegistration(eventId, reg.user.id)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          {registered.length === 0 && <p className="text-muted-foreground italic">No registered users.</p>}
        </div>
      </div>

      {/* WAITLIST */}
      <div>
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
          Waitlist <Badge variant="secondary">{waitlisted.length}</Badge>
          <span className="text-xs font-normal text-muted-foreground">(Drag to reorder)</span>
        </h3>
        
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={waitlistIds} strategy={verticalListSortingStrategy}>
            <div className="grid gap-2">
              {waitlistIds.map(id => {
                const reg = waitlisted.find(r => r.id === id);
                if (!reg) return null;
                return (
                  <SortableItem key={id} id={id}>
                    <div className="flex items-center justify-between p-3 border rounded-md bg-yellow-500/5 cursor-move">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-muted-foreground w-6 text-center">{waitlistIds.indexOf(id) + 1}</span>
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={reg.user.avatarUrl || undefined} />
                          <AvatarFallback>{reg.user.displayName[0]}</AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-bold">{reg.user.displayName}</div>
                          <div className="text-xs text-muted-foreground">Joined: {new Date(reg.createdAt).toLocaleString()}</div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          variant="default" 
                          onClick={() => overrideRegistrationStatus(eventId, reg.user.id, "REGISTERED", "Admin promote")}
                        >
                          Promote
                        </Button>
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          className="text-red-500"
                          onClick={() => removeRegistration(eventId, reg.user.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </SortableItem>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
        {waitlisted.length === 0 && <p className="text-muted-foreground italic">No waitlisted users.</p>}
      </div>

      {/* NOT ATTENDING */}
      <div>
        <h3 className="text-lg font-bold mb-4">Not Attending / Removed</h3>
        <div className="grid gap-2 opacity-60">
          {notAttending.map(reg => (
            <div key={reg.id} className="flex items-center justify-between p-2 border rounded-md">
              <div className="flex items-center gap-3">
                <div className="font-medium">{reg.user.displayName}</div>
              </div>
              <Button 
                size="sm" 
                variant="outline" 
                onClick={() => overrideRegistrationStatus(eventId, reg.user.id, "REGISTERED", "Admin restore")}
              >
                Register
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
