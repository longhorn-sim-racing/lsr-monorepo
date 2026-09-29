"use client";

import { useState, useTransition } from "react";
import { User, Role, MembershipTier, UserRole, UserMembership } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { updateUser, type UpdateUserPayload } from "@/server/actions/users";
import { useRouter } from "next/navigation";
import { format, addMonths } from "date-fns";
import { Loader2 } from "lucide-react";

type FullUser = User & {
    officerTitle: string | null;
    roles: (UserRole & { role: Role })[];
    memberships: (UserMembership & { tier: MembershipTier })[];
};

interface UserEditFormProps {
    user: FullUser;
    currentUser: User;
    allRoles: Role[];
    allTiers: MembershipTier[];
}

export function UserEditForm({ user, currentUser, allRoles, allTiers }: UserEditFormProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const [displayName, setDisplayName] = useState(user.displayName);
    const [handle, setHandle] = useState(user.handle);
    const [bio, setBio] = useState(user.bio || "");
    const [iRating, setIRating] = useState(user.iRating?.toString() || "");
    const [gradYear, setGradYear] = useState(user.gradYear?.toString() || "");
    const [major, setMajor] = useState(user.major || "");
    const userSocials = (user.socials as Record<string, string> | null) ?? {};
    const [website, setWebsite] = useState(userSocials.website || "");
    const [instagram, setInstagram] = useState(userSocials.instagram || "");
    const [twitch, setTwitch] = useState(userSocials.twitch || "");
    const [youtube, setYoutube] = useState(userSocials.youtube || "");
    const [officerTitle, setOfficerTitle] = useState(user.officerTitle || "");
    const [selectedRoleKeys, setSelectedRoleKeys] = useState<string[]>(
        user.roles.map((r) => r.role.key)
    );

    const activeMembership = user.memberships.find(m => !m.validTo || new Date(m.validTo) > new Date());
    const [selectedTierKey, setSelectedTierKey] = useState<string>(activeMembership?.tier.key || "GENERAL");
    const [validToDate, setValidToDate] = useState<string>(
        activeMembership?.validTo ? format(new Date(activeMembership.validTo), "yyyy-MM-dd") : ""
    );

    const handleRoleToggle = (roleKey: string) => {
        setSelectedRoleKeys((prev) =>
            prev.includes(roleKey)
                ? prev.filter((k) => k !== roleKey)
                : [...prev, roleKey]
        );
    };

    const onSubmit = () => {
        const socials: Record<string, string> = {};
        if (website.trim()) socials.website = website.trim();
        if (instagram.trim()) socials.instagram = instagram.trim();
        if (twitch.trim()) socials.twitch = twitch.trim();
        if (youtube.trim()) socials.youtube = youtube.trim();

        const payload: UpdateUserPayload = {
            displayName,
            handle,
            bio: bio || null,
            iRating: iRating ? parseInt(iRating, 10) : null,
            gradYear: gradYear ? parseInt(gradYear, 10) : null,
            major: major || null,
            socials: Object.keys(socials).length > 0 ? socials : null,
            officerTitle,
            roleKeys: selectedRoleKeys,
            activeMembershipTierKey: selectedTierKey === "GENERAL" ? null : selectedTierKey,
            activeMembershipValidTo: validToDate ? new Date(validToDate) : null,
        };

        startTransition(async () => {
            try {
                await updateUser(user.id, payload);
                toast.success("User updated successfully");
                router.refresh();
            } catch (error: any) {
                toast.error(error.message || "Failed to update user");
            }
        });
    };

    return (
        <div className="space-y-6">
            {/* Section: Identity */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Identity
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        Display name and unique handle for this user
                    </p>
                </div>
                <div className="p-6 space-y-5">
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="displayName" className="text-xs text-white/60 uppercase tracking-wider">
                            Display Name
                        </Label>
                        <Input
                            id="displayName"
                            placeholder="e.g. John Doe"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="handle" className="text-xs text-white/60 uppercase tracking-wider">
                            Handle
                        </Label>
                        <div className="flex items-center gap-2">
                            <span className="text-white/40 text-sm font-mono">@</span>
                            <Input
                                id="handle"
                                placeholder="e.g. john-doe"
                                value={handle}
                                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                className="rounded-none border-white/10 bg-white/5 text-white font-mono"
                            />
                        </div>
                        <p className="text-[10px] text-white/30">Lowercase letters, numbers, and hyphens only</p>
                    </div>
                </div>
            </section>

            {/* Section: Profile */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Profile
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        Driver details visible on their public profile
                    </p>
                </div>
                <div className="p-6 space-y-5">
                    <div className="space-y-2">
                        <Label htmlFor="bio" className="text-xs text-white/60 uppercase tracking-wider">
                            Bio
                        </Label>
                        <Textarea
                            id="bio"
                            rows={4}
                            placeholder="A short bio..."
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                        <div className="space-y-2">
                            <Label htmlFor="iRating" className="text-xs text-white/60 uppercase tracking-wider">
                                iRating
                            </Label>
                            <Input
                                id="iRating"
                                type="number"
                                placeholder="e.g. 2500"
                                value={iRating}
                                onChange={(e) => setIRating(e.target.value)}
                                className="rounded-none border-white/10 bg-white/5 text-white"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="gradYear" className="text-xs text-white/60 uppercase tracking-wider">
                                Grad Year
                            </Label>
                            <Input
                                id="gradYear"
                                type="number"
                                placeholder="e.g. 2027"
                                value={gradYear}
                                onChange={(e) => setGradYear(e.target.value)}
                                className="rounded-none border-white/10 bg-white/5 text-white"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="major" className="text-xs text-white/60 uppercase tracking-wider">
                                Major
                            </Label>
                            <Input
                                id="major"
                                placeholder="e.g. Computer Science"
                                value={major}
                                onChange={(e) => setMajor(e.target.value)}
                                className="rounded-none border-white/10 bg-white/5 text-white"
                            />
                        </div>
                    </div>
                </div>
            </section>

            {/* Section: Social Links */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Social Links
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        External links shown on the driver profile
                    </p>
                </div>
                <div className="p-6 space-y-5">
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="website" className="text-xs text-white/60 uppercase tracking-wider">
                            Website
                        </Label>
                        <Input
                            id="website"
                            type="url"
                            placeholder="https://example.com"
                            value={website}
                            onChange={(e) => setWebsite(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="instagram" className="text-xs text-white/60 uppercase tracking-wider">
                            Instagram
                        </Label>
                        <Input
                            id="instagram"
                            type="url"
                            placeholder="https://instagram.com/handle"
                            value={instagram}
                            onChange={(e) => setInstagram(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="twitch" className="text-xs text-white/60 uppercase tracking-wider">
                            Twitch
                        </Label>
                        <Input
                            id="twitch"
                            type="url"
                            placeholder="https://twitch.tv/handle"
                            value={twitch}
                            onChange={(e) => setTwitch(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="youtube" className="text-xs text-white/60 uppercase tracking-wider">
                            YouTube
                        </Label>
                        <Input
                            id="youtube"
                            type="url"
                            placeholder="https://youtube.com/@channel"
                            value={youtube}
                            onChange={(e) => setYoutube(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                </div>
            </section>

            {/* Section: Officer Title */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Officer Title
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        Only visible when the user has an officer or admin role
                    </p>
                </div>
                <div className="p-6">
                    <div className="max-w-sm space-y-2">
                        <Label htmlFor="officerTitle" className="text-xs text-white/60 uppercase tracking-wider">
                            Title
                        </Label>
                        <Input
                            id="officerTitle"
                            placeholder="e.g. President, Treasurer"
                            value={officerTitle}
                            onChange={(e) => setOfficerTitle(e.target.value)}
                            className="rounded-none border-white/10 bg-white/5 text-white"
                        />
                    </div>
                </div>
            </section>

            {/* Section: Roles & Permissions */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Roles & Permissions
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        Controls access to admin features and public badges
                    </p>
                </div>
                <div className="p-6 space-y-3">
                    {allRoles.map((role) => {
                        const isChecked = selectedRoleKeys.includes(role.key);
                        return (
                            <label
                                key={role.id}
                                className="flex items-start gap-3 p-3 border border-white/5 hover:border-white/10 hover:bg-white/[0.02] transition-colors cursor-pointer"
                            >
                                <Checkbox
                                    id={role.key}
                                    checked={isChecked}
                                    onCheckedChange={() => handleRoleToggle(role.key)}
                                    className="mt-0.5"
                                />
                                <div className="space-y-0.5">
                                    <span className="font-bold text-xs text-white uppercase tracking-wider">
                                        {role.key}
                                    </span>
                                    {role.description && (
                                        <p className="text-[10px] text-white/40">
                                            {role.description}
                                        </p>
                                    )}
                                </div>
                            </label>
                        );
                    })}

                    <div className="bg-amber-900/20 border border-amber-900/50 p-4 text-xs text-amber-200 mt-4">
                        <strong>Caution:</strong> Modifying admin or officer roles is restricted
                        to System Administrators.
                    </div>
                </div>
            </section>

            {/* Section: Membership */}
            <section className="border border-white/10 bg-lsr-charcoal">
                <div className="px-6 py-4 border-b border-white/10">
                    <h2 className="font-sans font-black text-sm uppercase tracking-widest text-white">
                        Membership
                    </h2>
                    <p className="text-[10px] text-white/40 uppercase tracking-wider mt-1">
                        Membership tier (Alumni, Partner). LSR doesn&apos;t charge dues right now.
                    </p>
                </div>
                <div className="p-6 space-y-5">
                    <div className="max-w-sm space-y-2">
                        <Label className="text-xs text-white/60 uppercase tracking-wider">
                            Tier
                        </Label>
                        <Select value={selectedTierKey} onValueChange={setSelectedTierKey}>
                            <SelectTrigger className="rounded-none border-white/10 bg-white/5 text-white">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-none border-white/10 bg-lsr-charcoal text-white">
                                {allTiers.map(t => (
                                    <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {selectedTierKey !== "GENERAL" && selectedTierKey !== "ALUMNI" && (
                        <div className="max-w-sm space-y-2">
                            <Label className="text-xs text-white/60 uppercase tracking-wider">
                                Valid Until
                            </Label>
                            <Input
                                type="date"
                                value={validToDate}
                                onChange={(e) => setValidToDate(e.target.value)}
                                className="rounded-none border-white/10 bg-white/5 text-white"
                            />
                            <div className="flex gap-2 pt-1">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-3 text-[10px] uppercase tracking-widest rounded-none border-white/10 text-white/50 hover:text-white hover:border-white/20"
                                    onClick={() => setValidToDate(format(addMonths(new Date(), 6), "yyyy-MM-dd"))}
                                >
                                    +6 Months
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-3 text-[10px] uppercase tracking-widest rounded-none border-white/10 text-white/50 hover:text-white hover:border-white/20"
                                    onClick={() => setValidToDate(format(addMonths(new Date(), 12), "yyyy-MM-dd"))}
                                >
                                    +1 Year
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </section>

            {/* Save */}
            <div className="flex justify-end pt-2">
                <Button
                    disabled={isPending}
                    onClick={onSubmit}
                    className="rounded-none font-bold uppercase tracking-widest text-[10px] h-10 px-8 bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal transition-all"
                >
                    {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Changes
                </Button>
            </div>
        </div>
    );
}
