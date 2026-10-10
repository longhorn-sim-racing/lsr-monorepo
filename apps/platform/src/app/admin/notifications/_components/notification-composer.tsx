"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send, User, Users, Search, Loader2, X, UserPlus } from "lucide-react";
import { sendCustomNotification, searchUsers } from "../actions";
import { toast } from "sonner";
import { unexpectedError } from "@/lib/action-result";

type UserResult = {
  id: string;
  displayName: string;
  email: string;
  handle: string;
};

export function NotificationComposer() {
  const [isPending, startTransition] = useTransition();
  const [recipientType, setRecipientType] = useState<"single" | "multiple" | "all">("single");
  const [selectedUsers, setSelectedUsers] = useState<UserResult[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [sendInApp, setSendInApp] = useState(true);
  const [sendEmail, setSendEmail] = useState(true);

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length >= 2) {
      setIsSearching(true);
      const results = await searchUsers(query);
      // Filter out already selected users
      const filtered = results.filter(
        (user) => !selectedUsers.some((s) => s.id === user.id)
      );
      setSearchResults(filtered);
      setIsSearching(false);
    } else {
      setSearchResults([]);
    }
  };

  const addUser = (user: UserResult) => {
    if (recipientType === "single") {
      setSelectedUsers([user]);
    } else {
      setSelectedUsers((prev) => [...prev, user]);
    }
    setSearchQuery("");
    setSearchResults([]);
  };

  const removeUser = (userId: string) => {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== userId));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    formData.set("recipientType", recipientType);
    if (selectedUsers.length > 0) {
      formData.set("userIds", JSON.stringify(selectedUsers.map((u) => u.id)));
    }

    startTransition(async () => {
      try {
        const result = await sendCustomNotification(formData);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        const count = recipientType === "all" ? "all members" : `${selectedUsers.length} user(s)`;
        toast.success(`Notification sent to ${count}`);
        form.reset();
        setSelectedUsers([]);
        setSearchQuery("");
      } catch (error) {
        console.error(error);
        toast.error(unexpectedError(error, "Couldn't send the notification"));
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="border border-white/10 bg-white/[0.02] p-6 space-y-6">
        {/* Recipient Selection */}
        <div className="space-y-4">
          <Label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">
            Recipients
          </Label>

          <Select
            value={recipientType}
            onValueChange={(v) => {
              setRecipientType(v as "single" | "multiple" | "all");
              // Clear selection when switching types
              if (v === "all") setSelectedUsers([]);
              if (v === "single" && selectedUsers.length > 1) {
                setSelectedUsers(selectedUsers.slice(0, 1));
              }
            }}
          >
            <SelectTrigger className="rounded-none bg-white/5 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-none bg-lsr-charcoal border-white/10">
              <SelectItem value="single" className="rounded-none">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Single User
                </div>
              </SelectItem>
              <SelectItem value="multiple" className="rounded-none">
                <div className="flex items-center gap-2">
                  <UserPlus className="h-4 w-4" />
                  Multiple Users
                </div>
              </SelectItem>
              <SelectItem value="all" className="rounded-none">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  All Active Members
                </div>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* User Search */}
          {(recipientType === "single" || recipientType === "multiple") && (
            <div className="space-y-3">
              {/* Selected Users */}
              {selectedUsers.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedUsers.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center gap-2 px-3 py-1.5 bg-lsr-orange/10 border border-lsr-orange/30"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm text-white leading-tight">
                          {user.displayName}
                        </span>
                        <span className="text-[10px] text-white/50 leading-tight">
                          {user.email}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeUser(user.id)}
                        className="text-white/50 hover:text-red-500 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Search Input - show if multiple or if single with no selection */}
              {(recipientType === "multiple" || selectedUsers.length === 0) && (
                <div className="relative">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
                    <Input
                      type="text"
                      placeholder={
                        recipientType === "multiple"
                          ? "Search to add users..."
                          : "Search by name, email, or handle..."
                      }
                      value={searchQuery}
                      onChange={(e) => handleSearch(e.target.value)}
                      className="rounded-none bg-white/5 border-white/10 text-white pl-10"
                    />
                    {isSearching && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 animate-spin" />
                    )}
                  </div>

                  {/* Search Results Dropdown */}
                  {searchResults.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-lsr-charcoal border border-white/10 max-h-48 overflow-y-auto">
                      {searchResults.map((user) => (
                        <button
                          key={user.id}
                          type="button"
                          onClick={() => addUser(user)}
                          className="w-full px-4 py-2 text-left hover:bg-white/5 flex flex-col"
                        >
                          <span className="text-sm text-white">{user.displayName}</span>
                          <span className="text-xs text-white/40">
                            {user.email} &bull; @{user.handle}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {recipientType === "multiple" && selectedUsers.length > 0 && (
                <p className="text-xs text-white/40">
                  {selectedUsers.length} user{selectedUsers.length !== 1 ? "s" : ""} selected
                </p>
              )}
            </div>
          )}

          {recipientType === "all" && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30">
              <p className="text-sm text-yellow-500">
                This will send a notification to all active members.
              </p>
            </div>
          )}
        </div>

        {/* Channels */}
        <div className="space-y-4">
          <Label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">
            Channels
          </Label>
          <div className="flex gap-6">
            <div className="flex items-center gap-2">
              <Checkbox
                id="sendInApp"
                name="sendInApp"
                checked={sendInApp}
                onCheckedChange={(c) => setSendInApp(c === true)}
                className="rounded-none border-white/30 data-[state=checked]:bg-lsr-orange data-[state=checked]:border-lsr-orange"
              />
              <Label htmlFor="sendInApp" className="text-sm text-white cursor-pointer">
                In-App
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="sendEmail"
                name="sendEmail"
                checked={sendEmail}
                onCheckedChange={(c) => setSendEmail(c === true)}
                className="rounded-none border-white/30 data-[state=checked]:bg-lsr-orange data-[state=checked]:border-lsr-orange"
              />
              <Label htmlFor="sendEmail" className="text-sm text-white cursor-pointer">
                Email
              </Label>
            </div>
          </div>
        </div>

        {/* Title */}
        <div className="space-y-2">
          <Label
            htmlFor="title"
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60"
          >
            Title
          </Label>
          <Input
            id="title"
            name="title"
            required
            placeholder="Notification title..."
            className="rounded-none bg-white/5 border-white/10 text-white"
          />
        </div>

        {/* Body */}
        <div className="space-y-2">
          <Label
            htmlFor="body"
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60"
          >
            Body
          </Label>
          <textarea
            id="body"
            name="body"
            required
            rows={4}
            placeholder="Notification body..."
            className="w-full rounded-none bg-white/5 border border-white/10 text-white p-3 focus:outline-none focus:border-lsr-orange"
          />
        </div>

        {/* Action URL */}
        <div className="space-y-2">
          <Label
            htmlFor="actionUrl"
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60"
          >
            Action URL (Optional)
          </Label>
          <div className="grid md:grid-cols-2 gap-4">
            <Input
              id="actionUrl"
              name="actionUrl"
              placeholder="/events/my-event"
              className="rounded-none bg-white/5 border-white/10 text-white"
            />
            <Input
              id="actionText"
              name="actionText"
              placeholder="Button text (default: View Details)"
              className="rounded-none bg-white/5 border-white/10 text-white"
            />
          </div>
          <p className="text-xs text-white/40">
            Link and button text for the email call-to-action
          </p>
        </div>

        {/* Schedule */}
        <div className="space-y-2">
          <Label
            htmlFor="scheduledFor"
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60"
          >
            Schedule For, Central Time (Optional)
          </Label>
          <Input
            id="scheduledFor"
            name="scheduledFor"
            type="datetime-local"
            className="rounded-none bg-white/5 border-white/10 text-white"
          />
          <p className="text-xs text-white/40">
            Leave empty to send immediately
          </p>
        </div>
      </div>

      {/* Submit */}
      <Button
        type="submit"
        disabled={
          isPending ||
          (!sendInApp && !sendEmail) ||
          ((recipientType === "single" || recipientType === "multiple") && selectedUsers.length === 0)
        }
        className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <Send className="h-4 w-4 mr-2" />
        )}
        Send Notification
      </Button>
    </form>
  );
}
