"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setRacingNumberAction } from "@/server/actions/racing-number";
import { toast } from "sonner";

export function RacingNumberPrompt({
  userId,
  hasRacingNumber,
}: {
  userId: string | null;
  hasRacingNumber: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [color, setColor] = useState("#FFFFFF");
  const [font, setFont] = useState("sans-serif");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (userId && !hasRacingNumber) {
      const hasSkipped = sessionStorage.getItem("skipRacingNumberPrompt");
      if (hasSkipped) return;
      
      // Delay to avoid jarring flash right on load
      const t = setTimeout(() => setOpen(true), 500);
      return () => clearTimeout(t);
    }
  }, [userId, hasRacingNumber]);

  if (!userId || hasRacingNumber) return null;

  function handleSkip() {
    sessionStorage.setItem("skipRacingNumberPrompt", "true");
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!number) return;

    setLoading(true);
    try {
      const parsed = parseInt(number, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 999) {
        toast.error("Please enter a valid number between 0 and 999.");
        setLoading(false);
        return;
      }
      await setRacingNumberAction({
        racingNumber: parsed,
        racingNumberColor: color,
        racingNumberFont: font,
      });
      toast.success("Racing number reserved successfully!");
      setOpen(false);
      router.refresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to reserve number. It might be taken.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="bg-lsr-charcoal border-white/10 rounded-none sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="font-display font-black italic text-2xl uppercase tracking-normal">
            Choose Your <span className="text-lsr-orange">Racing Number</span>
          </DialogTitle>
          <DialogDescription className="font-sans text-white/60">
            Welcome to the grid! Every driver needs a racing number. Reserve yours now before someone else takes it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6 py-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="racing-number" className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em]">
                Racing Number (0-999)
              </Label>
              <Input
                id="racing-number"
                type="number"
                min="0"
                max="999"
                placeholder="e.g. 42"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange text-xl placeholder:text-white/20"
                required
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="racing-color" className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em]">
                  Number Color
                </Label>
                <div className="flex gap-2 items-center h-12">
                  <Input
                    id="racing-color"
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="w-12 h-12 p-1 rounded-none bg-white/5 border-white/10 cursor-pointer"
                  />
                  <Input
                    type="text"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="flex-1 rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange uppercase"
                    pattern="^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="racing-font" className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em]">
                  Number Font
                </Label>
                <select
                  id="racing-font"
                  value={font}
                  onChange={(e) => setFont(e.target.value)}
                  className="flex h-12 w-full rounded-none border border-white/10 bg-[#1e1e1e] px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-lsr-orange disabled:cursor-not-allowed disabled:opacity-50 font-medium"
                >
                  <option value="sans-serif">Sans Serif</option>
                  <option value="serif">Serif</option>
                  <option value="monospace">Monospace</option>
                  <option value="Impact, sans-serif">Impact</option>
                  <option value="Arial Black, sans-serif">Arial Black</option>
                  <option value="Trebuchet MS, sans-serif">Trebuchet</option>
                  <option value="Verdana, sans-serif">Verdana</option>
                </select>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-center py-6 bg-black/20 border border-white/5 min-h-[140px] overflow-hidden">
              <div
                className="text-[6rem] leading-none italic font-black transition-all duration-300"
                style={{ color, fontFamily: font }}
              >
                {number || "42"}
              </div>
            </div>
          </div>
          <DialogFooter className="flex gap-2 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={handleSkip}
              className="rounded-none hover:bg-white/5 text-white/60 uppercase tracking-widest text-[10px] font-bold"
            >
              Skip for now
            </Button>
            <Button
              type="submit"
              disabled={loading}
              className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] px-8 transition-all"
            >
              {loading ? "Saving..." : "Reserve Number"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}