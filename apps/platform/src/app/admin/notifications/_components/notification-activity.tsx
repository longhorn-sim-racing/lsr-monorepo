"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Notification } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronUp,
  Mail,
  Bell,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { retryFailedNotification, deleteNotificationAdmin, getRecentNotifications } from "../actions";

type NotificationWithUser = Notification & {
  user: { id: string; displayName: string; email: string };
};

export function NotificationActivity({
  notifications: initialNotifications,
}: {
  notifications: NotificationWithUser[];
}) {
  const [items, setItems] = useState<NotificationWithUser[]>(initialNotifications);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initialNotifications.length >= 20);

  const loadMore = async () => {
    setIsLoadingMore(true);
    try {
      const newItems = await getRecentNotifications(20, items.length);
      if (newItems.length < 20) {
        setHasMore(false);
      }
      setItems((prev) => [...prev, ...newItems]);
    } catch (error) {
      console.error("Failed to load more notifications", error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleRetry = async (id: string) => {
    setRetrying(id);
    try {
      await retryFailedNotification(id);
    } finally {
      setRetrying(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this notification?")) return;
    setDeleting(id);
    try {
      await deleteNotificationAdmin(id);
      setItems((prev) => prev.filter((n) => n.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "SENT":
        return (
          <Badge
            variant="outline"
            className="bg-green-500/10 text-green-500 border-green-500/30 rounded-none"
          >
            Sent
          </Badge>
        );
      case "FAILED":
        return (
          <Badge
            variant="outline"
            className="bg-red-500/10 text-red-500 border-red-500/30 rounded-none"
          >
            Failed
          </Badge>
        );
      case "PENDING":
        return (
          <Badge
            variant="outline"
            className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30 rounded-none"
          >
            Pending
          </Badge>
        );
      case "CANCELLED":
        return (
          <Badge
            variant="outline"
            className="bg-white/10 text-white/50 border-white/20 rounded-none"
          >
            Cancelled
          </Badge>
        );
      default:
        return null;
    }
  };

  if (items.length === 0) {
    return (
      <div className="border border-white/10 bg-white/[0.02] p-8 text-center">
        <Bell className="h-12 w-12 mx-auto text-white/20 mb-4" />
        <p className="text-white/60">No notifications yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="border border-white/10 bg-white/[0.02]">
        {/* Header */}
        <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-white/10 text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">
          <div className="col-span-3">User</div>
          <div className="col-span-2">Type</div>
          <div className="col-span-2">Channel</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Time</div>
          <div className="col-span-1"></div>
        </div>

        {/* Rows */}
        {items.map((notification) => (
          <div key={notification.id} className="border-b border-white/5 last:border-b-0">
            <div
              className="grid grid-cols-12 gap-4 px-4 py-3 items-center hover:bg-white/[0.02] cursor-pointer"
              onClick={() =>
                setExpandedId(expandedId === notification.id ? null : notification.id)
              }
            >
              <div className="col-span-3">
                <p className="text-sm font-medium text-white truncate">
                  {notification.user.displayName}
                </p>
                <p className="text-xs text-white/40 truncate">
                  {notification.user.email}
                </p>
              </div>
              <div className="col-span-2">
                <span className="text-xs font-mono text-white/60">
                  {notification.type}
                </span>
              </div>
              <div className="col-span-2">
                {notification.channel === "EMAIL" ? (
                  <div className="flex items-center gap-1 text-white/60">
                    <Mail className="h-3 w-3" />
                    <span className="text-xs">Email</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 text-white/60">
                      <Bell className="h-3 w-3" />
                      <span className="text-xs">In-App</span>
                    </div>
                    <span title={notification.readAt ? "Read" : "Unread"}>
                      {notification.readAt ? (
                        <Eye className="h-3 w-3 text-green-500" />
                      ) : (
                        <EyeOff className="h-3 w-3 text-white/30" />
                      )}
                    </span>
                    {notification.dismissedAt && (
                      <span title="Dismissed by user">
                        <Trash2 className="h-3 w-3 text-yellow-500" />
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="col-span-2">{getStatusBadge(notification.status)}</div>
              <div className="col-span-2">
                <span className="text-xs text-white/40">
                  {format(new Date(notification.createdAt), "MMM d, h:mm a")}
                </span>
              </div>
              <div className="col-span-1 flex justify-end">
                {expandedId === notification.id ? (
                  <ChevronUp className="h-4 w-4 text-white/40" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-white/40" />
                )}
              </div>
            </div>

            {/* Expanded content */}
            {expandedId === notification.id && (
              <div className="px-4 py-4 bg-white/[0.02] border-t border-white/5">
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-1">
                      Title
                    </p>
                    <p className="text-sm text-white">{notification.title}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-1">
                      Body
                    </p>
                    <p className="text-sm text-white/70">{notification.body}</p>
                  </div>
                  {notification.actionUrl && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-1">
                        Action URL
                      </p>
                      <p className="text-sm text-lsr-orange">{notification.actionUrl}</p>
                    </div>
                  )}
                  {notification.emailError && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-red-500 mb-1">
                        Error
                      </p>
                      <p className="text-sm text-red-400 font-mono">
                        {notification.emailError}
                      </p>
                    </div>
                  )}
                  {notification.channel === "IN_APP" && (
                    <div className="grid grid-cols-2 gap-4 p-3 bg-white/[0.02] border border-white/5">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-1">
                          Read Status
                        </p>
                        <div className="flex items-center gap-2">
                          {notification.readAt ? (
                            <>
                              <Eye className="h-4 w-4 text-green-500" />
                              <span className="text-sm text-green-500">
                                Read {format(new Date(notification.readAt), "MMM d, h:mm a")}
                              </span>
                            </>
                          ) : (
                            <>
                              <EyeOff className="h-4 w-4 text-white/40" />
                              <span className="text-sm text-white/40">Unread</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 mb-1">
                          Dismissed
                        </p>
                        <div className="flex items-center gap-2">
                          {notification.dismissedAt ? (
                            <>
                              <Trash2 className="h-4 w-4 text-yellow-500" />
                              <span className="text-sm text-yellow-500">
                                Dismissed {format(new Date(notification.dismissedAt), "MMM d, h:mm a")}
                              </span>
                            </>
                          ) : (
                            <span className="text-sm text-white/40">Not dismissed</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {notification.status === "FAILED" && (
                      <Button
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRetry(notification.id);
                        }}
                        disabled={retrying === notification.id}
                        className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal text-[10px] uppercase tracking-widest"
                      >
                        {retrying === notification.id ? (
                          <RefreshCw className="h-3 w-3 animate-spin mr-2" />
                        ) : (
                          <RefreshCw className="h-3 w-3 mr-2" />
                        )}
                        Retry
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(notification.id);
                      }}
                      disabled={deleting === notification.id}
                      className="rounded-none text-white/50 hover:text-red-500 hover:bg-red-500/10 text-[10px] uppercase tracking-widest"
                    >
                      {deleting === notification.id ? (
                        <Trash2 className="h-3 w-3 animate-pulse mr-2" />
                      ) : (
                        <Trash2 className="h-3 w-3 mr-2" />
                      )}
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={loadMore}
            disabled={isLoadingMore}
            className="rounded-none border-white/10 text-white hover:bg-white hover:text-lsr-charcoal uppercase tracking-widest text-xs"
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              "Load More"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
