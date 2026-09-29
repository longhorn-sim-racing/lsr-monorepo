"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProductType } from "@prisma/client";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { centsToDollarInput } from "@/lib/money";
import { updateProduct } from "@/server/actions/products";
import type { ProductMetadataFields } from "@/schemas/product.schema";

type EditableProduct = ProductMetadataFields & {
    id: string;
    type: ProductType;
    name: string;
    amountCents: number;
    active: boolean;
};

export type SeasonOption = {
    slug: string;
    /** Season name, or null for a saved slug that isn't a Season. */
    name: string | null;
};

type FieldErrors = Record<string, string[] | undefined>;

interface ProductEditFormProps {
    product: EditableProduct;
    seasonOptions: SeasonOption[];
}

export function ProductEditForm({ product, seasonOptions }: ProductEditFormProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const isLeague = product.type === "LEAGUE_FEE";

    const [name, setName] = useState(product.name);
    const [amount, setAmount] = useState(centsToDollarInput(product.amountCents));
    const [active, setActive] = useState(product.active);
    const [returningAmount, setReturningAmount] = useState(centsToDollarInput(product.returningAmountCents));
    const [returningSeasonSlugs, setReturningSeasonSlugs] = useState(product.returningSeasonSlugs);
    const [requiresMembership, setRequiresMembership] = useState(product.requiresMembership);
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

    const toggleSeason = (slug: string) => {
        setReturningSeasonSlugs((prev) =>
            prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
        );
    };

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        startTransition(async () => {
            const result = await updateProduct(product.id, {
                name,
                amount,
                active,
                returningAmount: isLeague ? returningAmount : "",
                returningSeasonSlugs: isLeague ? returningSeasonSlugs : [],
                requiresMembership: isLeague && requiresMembership,
            });
            if (result.ok) {
                setFieldErrors({});
                toast.success("Product saved");
                router.refresh();
            } else {
                setFieldErrors(result.fieldErrors ?? {});
                toast.error(result.error);
            }
        });
    };

    return (
        <form onSubmit={onSubmit} className="space-y-6">
            {/* Section: Details */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Details
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        Name and standard price shown at checkout
                    </p>
                </div>
                <div className="p-6 space-y-5">
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="name" className="text-xs text-white/60 uppercase tracking-wider">
                            Name
                        </Label>
                        <Input
                            id="name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                        <FieldError messages={fieldErrors.name} />
                    </div>
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="amount" className="text-xs text-white/60 uppercase tracking-wider">
                            Price (USD)
                        </Label>
                        <DollarInput id="amount" value={amount} onChange={setAmount} />
                        <FieldError messages={fieldErrors.amount} />
                    </div>
                    <label className="flex items-start gap-3 p-3 border border-white/5 hover:border-white/10 hover:bg-white/[0.02] transition-colors cursor-pointer">
                        <Switch
                            checked={active}
                            onCheckedChange={setActive}
                            className="mt-0.5 data-[state=checked]:bg-lsr-orange"
                        />
                        <div className="space-y-0.5">
                            <span className="font-bold text-xs text-white uppercase tracking-wider">Active</span>
                            <p className="text-[10px] text-white/40">
                                Inactive products can&apos;t be bought.
                            </p>
                        </div>
                    </label>
                </div>
            </section>

            {isLeague && (
                <>
                    {/* Section: Returning drivers */}
                    <section className="border border-white/10 bg-lsr-charcoal">
                        <div className="px-6 py-4 border-b border-white/10">
                            <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                                Returning Drivers
                            </h2>
                            <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                                A lower price for drivers in the standings of a past season
                            </p>
                        </div>
                        <div className="p-6 space-y-5">
                            <div className="max-w-sm space-y-2">
                                <Label htmlFor="returningAmount" className="text-xs text-white/60 uppercase tracking-wider">
                                    Returning Price (USD)
                                </Label>
                                <DollarInput
                                    id="returningAmount"
                                    value={returningAmount}
                                    onChange={setReturningAmount}
                                    placeholder="None"
                                />
                                <p className="text-[10px] text-white/30">
                                    Leave blank to charge everyone the standard price. Must be less than the standard price.
                                </p>
                                <FieldError messages={fieldErrors.returningAmount} />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-xs text-white/60 uppercase tracking-wider">
                                    Counts as Returning
                                </Label>
                                {seasonOptions.length === 0 ? (
                                    <p className="text-[10px] text-white/40">No seasons exist yet.</p>
                                ) : (
                                    <div className="max-h-72 overflow-y-auto space-y-1 border border-white/5 p-2">
                                        {seasonOptions.map((season) => (
                                            <label
                                                key={season.slug}
                                                className="flex items-start gap-3 p-2 hover:bg-white/[0.02] transition-colors cursor-pointer"
                                            >
                                                <Checkbox
                                                    checked={returningSeasonSlugs.includes(season.slug)}
                                                    onCheckedChange={() => toggleSeason(season.slug)}
                                                    className="mt-0.5"
                                                />
                                                <div className="min-w-0">
                                                    <span className="block text-xs font-bold text-white">
                                                        {season.name ?? season.slug}
                                                    </span>
                                                    <span className="block text-[10px] font-mono text-white/40">
                                                        {season.name ? season.slug : "Saved slug, not a season"}
                                                    </span>
                                                </div>
                                            </label>
                                        ))}
                                    </div>
                                )}
                                <FieldError messages={fieldErrors.returningSeasonSlugs} />
                            </div>
                        </div>
                    </section>

                    {/* Section: Entry requirements */}
                    <section className="border border-white/10 bg-lsr-charcoal">
                        <div className="px-6 py-4 border-b border-white/10">
                            <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                                Entry Requirements
                            </h2>
                            <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                                Checked when a driver starts checkout
                            </p>
                        </div>
                        <div className="p-6">
                            <label className="flex items-start gap-3 p-3 border border-white/5 hover:border-white/10 hover:bg-white/[0.02] transition-colors cursor-pointer">
                                <Checkbox
                                    checked={requiresMembership}
                                    onCheckedChange={(checked) => setRequiresMembership(checked === true)}
                                    className="mt-0.5"
                                />
                                <span className="font-bold text-xs text-white uppercase tracking-wider">
                                    Require paid LSR dues before entry
                                </span>
                            </label>
                        </div>
                    </section>
                </>
            )}

            {/* Save */}
            <div className="flex justify-end pt-2">
                <Button
                    type="submit"
                    disabled={isPending}
                    className="rounded-none font-bold uppercase tracking-widest text-[10px] h-10 px-8 bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal transition-all"
                >
                    {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Changes
                </Button>
            </div>
        </form>
    );
}

function DollarInput({
    id,
    value,
    onChange,
    placeholder = "0.00",
}: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm font-mono">$</span>
            <Input
                id={id}
                inputMode="decimal"
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="rounded-none border-white/10 bg-white/5 text-white font-mono"
            />
        </div>
    );
}

function FieldError({ messages }: { messages?: string[] }) {
    if (!messages?.length) return null;
    return <p className="text-[10px] text-red-400">{messages[0]}</p>;
}
