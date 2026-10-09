"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, Film, Layers, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CloudinaryImage } from "@/components/cloudinary-image";
import {
  connectInstagramAction,
  disconnectInstagramAction,
  setInstagramPostHiddenAction,
  syncInstagramAction,
} from "./actions";

type Status = {
  connected: boolean;
  username: string | null;
  lastSync: string | null;
  tokenExpires: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

type Post = {
  id: string;
  permalink: string;
  caption: string | null;
  mediaType: string;
  publicId: string | null;
  hidden: boolean;
  postedAt: string;
};

function syncSummary(result: { added: number; removed: number; error?: string }) {
  if (result.error) return result.error;
  const parts = [`${result.added} new`];
  if (result.removed) parts.push(`${result.removed} removed`);
  return `Up to date (${parts.join(", ")})`;
}

export function InstagramAdmin({ status, imagesReady, posts }: { status: Status; imagesReady: boolean; posts: Post[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);

  function connect() {
    startTransition(async () => {
      try {
        const result = await connectInstagramAction(token);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        setToken("");
        setReplacing(false);
        toast.success(`Connected @${result.username}. ${syncSummary(result.sync)}`);
      } catch {
        toast.error("Something went wrong. If it says connected after a refresh, it worked.");
      }
      router.refresh();
    });
  }

  function sync() {
    startTransition(async () => {
      try {
        const result = await syncInstagramAction();
        if (result.ok) toast.success(syncSummary(result));
        else toast.error(result.error ?? "Not connected");
      } catch {
        toast.error("The check didn't finish. It runs again on its own within the hour.");
      }
      router.refresh();
    });
  }

  function disconnect() {
    if (!window.confirm("Disconnect Instagram? Posts already on the site stay until you hide them.")) return;
    startTransition(async () => {
      try {
        await disconnectInstagramAction();
        toast.success("Disconnected");
      } catch {
        toast.error("Couldn't disconnect. Try again.");
      }
      router.refresh();
    });
  }

  function toggleHidden(post: Post) {
    startTransition(async () => {
      try {
        const result = await setInstagramPostHiddenAction(post.id, !post.hidden);
        if (!result.ok) toast.error(result.error);
      } catch {
        toast.error("Couldn't update that post. Try again.");
      }
      router.refresh();
    });
  }

  const showConnectForm = !status.connected || replacing;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Instagram</h1>
        <p className="text-white/60 mt-1">
          New posts from the club account show up on the News page within the hour.
        </p>
      </div>

      {!imagesReady && (
        <div className="flex gap-3 border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <p>
            This server can&apos;t copy images yet: <code>CLOUDINARY_API_KEY</code> and{" "}
            <code>CLOUDINARY_API_SECRET</code> need adding to its environment. Ask the Tech team.
          </p>
        </div>
      )}

      {/* Connection */}
      <section className="border border-white/10 bg-white/[0.02] p-6 space-y-5">
        {status.connected ? (
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div className="flex gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-white">Connected as @{status.username}</p>
                <p className="text-sm text-white/60">
                  {status.lastSync ? `Checked for new posts ${status.lastSync}.` : "Not checked yet."}
                </p>
                {status.tokenExpires && (
                  <p className="text-sm text-white/40">
                    Access renews itself every week. If renewing ever stops, it runs out on {status.tokenExpires}.
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button onClick={sync} disabled={pending} variant="outline">
                <RefreshCw className={`h-4 w-4 mr-2 ${pending ? "animate-spin" : ""}`} />
                Check now
              </Button>
              <Button onClick={disconnect} disabled={pending} variant="ghost" className="text-white/60">
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <p className="font-semibold text-white">Not connected</p>
            <p className="text-sm text-white/60 mt-1">
              Follow the Instagram setup guide, then paste the access token it gives you below.
            </p>
          </div>
        )}

        {status.lastError && (
          <div className="flex gap-3 border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p>
              {status.lastError}
              {status.lastErrorAt && <span className="text-red-200/60"> ({status.lastErrorAt})</span>}
            </p>
          </div>
        )}

        {showConnectForm ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <label htmlFor="instagram-token" className="text-sm font-medium text-white">
              Access token
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="instagram-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste the token from the Meta dashboard"
                className="font-mono"
              />
              <Button type="submit" disabled={pending || !token.trim()}>
                {pending ? "Connecting…" : "Connect"}
              </Button>
              {replacing && (
                <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-xs text-white/40">It&apos;s stored on the server and never shown again.</p>
          </form>
        ) : (
          <button type="button" onClick={() => setReplacing(true)} className="text-sm text-white/50 underline hover:text-white">
            Paste a new access token
          </button>
        )}
      </section>

      {/* Posts */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Posts</h2>
          <p className="text-sm text-white/60">The 8 newest visible posts appear on the News page. Hide any you&apos;d rather not show there.</p>
        </div>
        {posts.length === 0 ? (
          <p className="text-sm text-white/40">No posts copied yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {posts.map((post) => (
              <div key={post.id} className={`border border-white/10 bg-white/[0.02] ${post.hidden ? "opacity-50" : ""}`}>
                <div className="relative aspect-square bg-black/40">
                  {post.publicId ? (
                    <CloudinaryImage publicId={post.publicId} alt="" fill sizes="200px" className="object-cover" />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-white/40">
                      Image not copied yet
                    </span>
                  )}
                  {post.mediaType === "VIDEO" && <Film className="absolute top-2 right-2 h-4 w-4 text-white drop-shadow" />}
                  {post.mediaType === "CAROUSEL_ALBUM" && <Layers className="absolute top-2 right-2 h-4 w-4 text-white drop-shadow" />}
                </div>
                <div className="p-2 space-y-2">
                  <p className="text-xs text-white/50">{post.postedAt}</p>
                  {post.caption && <p className="text-xs text-white/70 line-clamp-2">{post.caption}</p>}
                  <div className="flex items-center justify-between gap-2">
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => toggleHidden(post)} className="h-7 text-xs">
                      {post.hidden ? <Eye className="h-3 w-3 mr-1" /> : <EyeOff className="h-3 w-3 mr-1" />}
                      {post.hidden ? "Show" : "Hide"}
                    </Button>
                    <a href={post.permalink} target="_blank" rel="noopener noreferrer" className="text-white/40 hover:text-white" aria-label="Open on Instagram">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
