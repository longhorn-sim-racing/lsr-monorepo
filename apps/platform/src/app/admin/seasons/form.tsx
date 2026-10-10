"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createSeason, updateSeason, recomputeStandings } from "./actions";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Season, EventSeries } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { toast } from "sonner";
import { unexpectedError } from "@/lib/action-result";

function SubmitButton({ isEditing }: { isEditing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : isEditing ? "Update Season" : "Create Season"}
    </Button>
  );
}

export function SeasonForm({ 
    initialData,
    seriesList,
    leagues,
}: {
    initialData?: Season | null,
    seriesList: EventSeries[],
    leagues: { id: string; name: string }[]
}) {
  const action = initialData ? updateSeason.bind(null, initialData.id) : createSeason;
  
  // Helper to safely access nested JSON or property
  const defaultPointsRule = (initialData?.pointsRule as { system?: string } | null | undefined)?.system || "F1";

  // Helper for date input format YYYY-MM-DD (season dates are Central time)
  const formatDate = (date: Date | null | undefined) => {
      if (!date) return "";
      return formatInTimeZone(new Date(date), DEFAULT_TIMEZONE, "yyyy-MM-dd");
  }
  
  const handleRecompute = async () => {
      if(!initialData) return;
      if(confirm("Recompute standings for this season based on ingested results? This will overwrite manual edits to Entry stats.")) {
          try {
              const result = await recomputeStandings(initialData.id);
              if (result.ok) toast.success("Standings recomputed");
              else toast.error(result.error);
          } catch (error) {
              console.error(error);
              toast.error(unexpectedError(error, "Couldn't recompute the standings"));
          }
      }
  }

  return (
    <div className="space-y-8">
        <form action={action} className="space-y-6 max-w-2xl border p-6 rounded-lg bg-white/5">
        <div className="space-y-2">
            <Label htmlFor="name">Season Name</Label>
            <Input
            id="name"
            name="name"
            defaultValue={initialData?.name}
            required
            placeholder="e.g. LSR GT3 Season 1"
            className="bg-black/20"
            />
        </div>

        <div className="space-y-2">
            <Label htmlFor="slug">Slug</Label>
            <Input
            id="slug"
            name="slug"
            defaultValue={initialData?.slug}
            required
            placeholder="e.g. lsr-gt3-s1"
            className="bg-black/20"
            />
        </div>

        <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
                <Label htmlFor="year">Year</Label>
                <Input
                id="year"
                name="year"
                type="number"
                defaultValue={initialData?.year || new Date().getFullYear()}
                required
                className="bg-black/20"
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="seriesId">Series</Label>
                <select 
                    id="seriesId"
                    name="seriesId" 
                    defaultValue={initialData?.seriesId || ""}
                    className="flex h-10 w-full rounded-md border border-input bg-black/20 px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <option value="">-- Select a Series --</option>
                    {seriesList.map((s) => (
                    <option key={s.id} value={s.id}>
                        {s.title}
                    </option>
                    ))}
                </select>
            </div>
        </div>

        <div className="space-y-2">
            <Label htmlFor="leagueId">League</Label>
            <select
                id="leagueId"
                name="leagueId"
                defaultValue={initialData?.leagueId || ""}
                className="flex h-10 w-full rounded-md border border-input bg-black/20 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
                <option value="">-- No league --</option>
                {leagues.map((l) => (
                <option key={l.id} value={l.id}>
                    {l.name}
                </option>
                ))}
            </select>
            <p className="text-xs text-white/40">
                Link league seasons so the league page shows them and its entry fee buys the next one that hasn&apos;t ended.
            </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
                <Label htmlFor="startAt">Start Date</Label>
                <Input
                id="startAt"
                name="startAt"
                type="date"
                defaultValue={formatDate(initialData?.startAt)}
                className="bg-black/20"
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="endAt">End Date</Label>
                <Input
                id="endAt"
                name="endAt"
                type="date"
                defaultValue={formatDate(initialData?.endAt)}
                className="bg-black/20"
                />
            </div>
        </div>

        <div className="space-y-2">
            <Label htmlFor="pointsRule">Default Points Ruleset</Label>
            <select 
                id="pointsRule"
                name="pointsRule" 
                defaultValue={defaultPointsRule}
                className="flex h-10 w-full rounded-md border border-input bg-black/20 px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <option value="F1">F1 (Default)</option>
                <option value="HALF">Half Points</option>
                <option value="NONE">None</option>
            </select>
            <p className="text-xs text-muted-foreground">Saved with the season for reference. Points are awarded by the ruleset picked on each results upload.</p>
        </div>

        <div className="flex gap-4 pt-4">
            <SubmitButton isEditing={!!initialData} />
            <Button variant="ghost" asChild>
            <Link href="/admin/seasons">Cancel</Link>
            </Button>
        </div>
        </form>

        {initialData && (
            <div className="max-w-2xl border p-6 rounded-lg bg-white/5 border-t border-white/10">
                <h3 className="text-lg font-bold mb-4">Season Actions</h3>
                <div className="flex items-center gap-4">
                    <Button type="button" variant="secondary" onClick={handleRecompute}>
                        Force Recompute Standings
                    </Button>
                    <p className="text-sm text-muted-foreground">
                        Updates standings based on all ingested results for this series within the date range.
                    </p>
                </div>
            </div>
        )}
    </div>
  );
}