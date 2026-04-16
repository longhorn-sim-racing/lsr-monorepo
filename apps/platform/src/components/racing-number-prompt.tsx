"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setRacingNumberAction } from "@/server/actions/racing-number";
import { toast } from "sonner";

export function RacingNumberDialog({
  open,
  setOpen,
  initialData,
  isUpdateMode,
  onSuccess
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  initialData?: {
    racingNumber?: number | null;
    racingNumberColor?: string | null;
    racingNumberFont?: string | null;
    racingNumberItalic?: boolean | null;
    racingNumberBorder?: boolean | null;
  };
  isUpdateMode?: boolean;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [number, setNumber] = useState(initialData?.racingNumber?.toString() || "");
  const [color, setColor] = useState(initialData?.racingNumberColor || "#FFFFFF");
  const [font, setFont] = useState(initialData?.racingNumberFont || "sans-serif");
  const [isItalic, setIsItalic] = useState(initialData?.racingNumberItalic || false);
  const [hasBorder, setHasBorder] = useState(initialData?.racingNumberBorder || false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && initialData) {
      setNumber(initialData.racingNumber?.toString() || "");
      setColor(initialData.racingNumberColor || "#FFFFFF");
      setFont(initialData.racingNumberFont || "sans-serif");
      setIsItalic(initialData.racingNumberItalic || false);
      setHasBorder(initialData.racingNumberBorder || false);
    }
  }, [open, initialData]);

  function handleSkip() {
    sessionStorage.setItem("skipRacingNumberPrompt", "true");
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
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
        racingNumberItalic: isItalic,
        racingNumberBorder: hasBorder,
      });
      toast.success(isUpdateMode ? "Racing number updated successfully!" : "Racing number reserved successfully!");
      setOpen(false);
      if (onSuccess) onSuccess();
      router.refresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to save number. It might be taken.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="bg-lsr-charcoal border-white/10 rounded-none sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="font-display font-black italic text-2xl uppercase tracking-normal">
            {isUpdateMode ? "Update Your " : "Choose Your "}
            <span className="text-lsr-orange">Racing Number</span>
          </DialogTitle>
          <DialogDescription className="font-sans text-white/60">
            {isUpdateMode
              ? "Update your custom racing number and its styling."
              : "Welcome to the grid! Every driver needs a racing number. Reserve yours now before someone else takes it."}
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
                autoFocus={!isUpdateMode}
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
                <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em]">
                  Number Font
                </Label>
                <Select value={font} onValueChange={setFont}>
                  <SelectTrigger className="w-full rounded-none border-white/10 bg-[#1e1e1e] text-white h-12 focus:ring-lsr-orange">
                    <SelectValue placeholder="Select a font" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1e1e1e] border-white/10 text-white">
                    <SelectItem value="sans-serif">Sans Serif</SelectItem>
                    <SelectItem value="serif">Serif</SelectItem>
                    <SelectItem value="monospace">Monospace</SelectItem>
                    <SelectItem value="Impact, sans-serif">Impact</SelectItem>
                    <SelectItem value="Arial Black, sans-serif">Arial Black</SelectItem>
                    <SelectItem value="Trebuchet MS, sans-serif">Trebuchet</SelectItem>
                    <SelectItem value="Verdana, sans-serif">Verdana</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-6 mt-2">
              <div className="flex items-center space-x-2">
                <Checkbox id="italic-mode" checked={isItalic} onCheckedChange={(val) => setIsItalic(!!val)} />
                <Label htmlFor="italic-mode" className="text-sm font-medium leading-none text-white/80 cursor-pointer">
                  Italic
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="border-mode" checked={hasBorder} onCheckedChange={(val) => setHasBorder(!!val)} />
                <Label htmlFor="border-mode" className="text-sm font-medium leading-none text-white/80 cursor-pointer">
                  White Border
                </Label>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-center py-6 bg-black/20 border border-white/5 min-h-[140px] overflow-hidden">
              <div
                className="text-[6rem] leading-none transition-all duration-300"
                style={{
                  color,
                  fontFamily: font,
                  fontStyle: isItalic ? "italic" : "normal",
                  fontWeight: 900,
                  WebkitTextStroke: hasBorder ? "2px white" : "none",
                }}
              >
                {number || "42"}
              </div>
            </div>
          </div>
          <DialogFooter className="flex gap-2 sm:justify-end">
            {!isUpdateMode && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleSkip}
                className="rounded-none hover:bg-white/5 text-white/60 uppercase tracking-widest text-[10px] font-bold"
              >
                Skip for now
              </Button>
            )}
            <Button
              type="submit"
              disabled={loading}
              className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] px-8 transition-all"
            >
              {loading ? "Saving..." : (isUpdateMode ? "Update Number" : "Reserve Number")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RacingNumberPrompt({
  userId,
  hasRacingNumber,
}: {
  userId: string | null;
  hasRacingNumber: boolean;
}) {
  const [open, setOpen] = useState(false);

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

  return <RacingNumberDialog open={open} setOpen={setOpen} isUpdateMode={false} />;
}

export function UpdateRacingNumberButton({ user }: { user: any }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        variant="outline"
        size="sm"
        className="rounded-none border-white/10 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px]"
      >
        Update Racing Number
      </Button>
      <RacingNumberDialog
        open={open}
        setOpen={setOpen}
        initialData={user}
        isUpdateMode={true}
      />
    </>
  );
}
