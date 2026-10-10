"use client";

import { toast } from "sonner";
import { updateHotlapSettings } from "./actions";
import { useFormAction } from "@/components/admin/use-form-action";
import type { HotlapSettings } from "@/lib/email/settings";

type Props = {
  initial: HotlapSettings | null;
};

export default function HotlapForm({ initial }: Props) {
  const { onSubmit, error, pending: isPending } = useFormAction(updateHotlapSettings, () => toast.success("Hotlap saved"));

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-xl">
      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="videoUrl" className="block text-sm font-medium text-white/80 mb-1">
            YouTube Video URL
          </label>
          <input
            id="videoUrl"
            name="videoUrl"
            type="url"
            required
            defaultValue={initial?.videoUrl ?? ""}
            placeholder="https://www.youtube.com/watch?v=..."
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-lsr-orange focus:outline-none focus:ring-1 focus:ring-lsr-orange"
          />
          <p className="text-xs text-white/40 mt-1">
            Supports youtube.com/watch?v=, youtu.be/, and youtube.com/embed/ links
          </p>
        </div>

        <div>
          <label htmlFor="driverName" className="block text-sm font-medium text-white/80 mb-1">
            Driver Name
          </label>
          <input
            id="driverName"
            name="driverName"
            type="text"
            required
            defaultValue={initial?.driverName ?? ""}
            placeholder="Bryan Reyes"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-lsr-orange focus:outline-none focus:ring-1 focus:ring-lsr-orange"
          />
        </div>

        <div>
          <label htmlFor="car" className="block text-sm font-medium text-white/80 mb-1">
            Car
          </label>
          <input
            id="car"
            name="car"
            type="text"
            required
            defaultValue={initial?.car ?? ""}
            placeholder="GT-M Hyperion V8 (GT3)"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-lsr-orange focus:outline-none focus:ring-1 focus:ring-lsr-orange"
          />
        </div>

        <div>
          <label htmlFor="track" className="block text-sm font-medium text-white/80 mb-1">
            Track
          </label>
          <input
            id="track"
            name="track"
            type="text"
            required
            defaultValue={initial?.track ?? ""}
            placeholder="Daytona International"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-lsr-orange focus:outline-none focus:ring-1 focus:ring-lsr-orange"
          />
        </div>

        <div>
          <label htmlFor="lapTime" className="block text-sm font-medium text-white/80 mb-1">
            Lap Time
          </label>
          <input
            id="lapTime"
            name="lapTime"
            type="text"
            required
            defaultValue={initial?.lapTime ?? ""}
            placeholder="1:46.043"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-lsr-orange focus:outline-none focus:ring-1 focus:ring-lsr-orange"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-lsr-orange px-4 py-2 text-sm font-semibold text-white hover:bg-lsr-orange/90 disabled:opacity-50 transition-colors"
      >
        {isPending ? "Saving..." : "Save Changes"}
      </button>
    </form>
  );
}
