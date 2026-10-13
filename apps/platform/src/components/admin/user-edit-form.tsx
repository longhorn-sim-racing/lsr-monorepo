"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { MembershipTier, Role, User, UserMembership, UserRole } from "@prisma/client"
import { addMonths, format } from "date-fns"
import { toast } from "sonner"
import {
  Button,
  CheckboxField,
  Field,
  FieldGrid,
  FormActions,
  FormSection,
  Input,
  Notice,
  Panel,
  PanelBody,
  PanelFooter,
  Select,
  Textarea,
} from "@/components/admin/kit"
import { updateUser, type UpdateUserPayload } from "@/server/actions/users"
import { unexpectedError } from "@/lib/action-result"
import { ROLE_LABEL, type RoleCode } from "@/lib/roles"

type FullUser = User & {
  officerTitle: string | null
  roles: (UserRole & { role: Role })[]
  memberships: (UserMembership & { tier: MembershipTier })[]
}

/** Roles only admins can give or take away (updateUser enforces this too). */
const STAFF_ROLES = ["admin", "officer"]

/** Tiers that don't expire, so they don't get a valid-until date. */
const OPEN_ENDED_TIERS = ["GENERAL", "ALUMNI"]

function Divider() {
  return <hr className="border-admin-row" />
}

export function UserEditForm({
  user,
  allRoles,
  allTiers,
  viewerIsAdmin,
}: {
  user: FullUser
  allRoles: Role[]
  allTiers: MembershipTier[]
  /** Officers who aren't admins can't edit staff accounts or hand out staff roles */
  viewerIsAdmin: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [displayName, setDisplayName] = useState(user.displayName)
  const [handle, setHandle] = useState(user.handle)
  const [bio, setBio] = useState(user.bio || "")
  const [iRating, setIRating] = useState(user.iRating?.toString() || "")
  const [gradYear, setGradYear] = useState(user.gradYear?.toString() || "")
  const [major, setMajor] = useState(user.major || "")
  const userSocials = (user.socials as Record<string, string> | null) ?? {}
  const [website, setWebsite] = useState(userSocials.website || "")
  const [instagram, setInstagram] = useState(userSocials.instagram || "")
  const [twitch, setTwitch] = useState(userSocials.twitch || "")
  const [youtube, setYoutube] = useState(userSocials.youtube || "")
  const [officerTitle, setOfficerTitle] = useState(user.officerTitle || "")
  const [selectedRoleKeys, setSelectedRoleKeys] = useState<string[]>(user.roles.map((r) => r.role.key))

  const activeMembership = user.memberships.find((m) => !m.validTo || new Date(m.validTo) > new Date())
  const [selectedTierKey, setSelectedTierKey] = useState<string>(activeMembership?.tier.key || "GENERAL")
  const [validToDate, setValidToDate] = useState<string>(
    activeMembership?.validTo ? format(new Date(activeMembership.validTo), "yyyy-MM-dd") : "",
  )

  const targetIsStaff = user.roles.some((r) => STAFF_ROLES.includes(r.role.key))
  const locked = targetIsStaff && !viewerIsAdmin

  const handleRoleToggle = (roleKey: string) => {
    setSelectedRoleKeys((prev) => (prev.includes(roleKey) ? prev.filter((k) => k !== roleKey) : [...prev, roleKey]))
  }

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()

    const socials: Record<string, string> = {}
    if (website.trim()) socials.website = website.trim()
    if (instagram.trim()) socials.instagram = instagram.trim()
    if (twitch.trim()) socials.twitch = twitch.trim()
    if (youtube.trim()) socials.youtube = youtube.trim()

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
    }

    startTransition(async () => {
      try {
        const result = await updateUser(user.id, payload)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success("Member saved")
        router.refresh()
      } catch (error) {
        console.error(error)
        toast.error(unexpectedError(error, "Couldn't save the member"))
      }
    })
  }

  const showValidTo = !OPEN_ENDED_TIERS.includes(selectedTierKey)

  return (
    <form onSubmit={onSubmit} className="min-w-0">
      <Panel>
        <PanelBody className="flex flex-col gap-5">
          {locked && (
            <Notice tone="warning" title="Only admins can edit officer and admin accounts">
              This member has the officer or admin role, so saving is off for you. Ask an admin to make changes here.
            </Notice>
          )}

          <FormSection title="Identity" description="Display name and the unique handle in their profile link.">
            <FieldGrid>
              <Field label="Display name" htmlFor="displayName" required>
                <Input id="displayName" placeholder="e.g. John Doe" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <Field label="Handle" htmlFor="handle" hint="Lowercase letters, numbers and hyphens">
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] text-admin-subtle">@</span>
                  <Input
                    id="handle"
                    className="pl-6"
                    placeholder="e.g. john-doe"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  />
                </div>
              </Field>
            </FieldGrid>
          </FormSection>

          <Divider />

          <FormSection title="Profile" description="Driver details on their public profile.">
            <Field label="Bio" htmlFor="bio">
              <Textarea id="bio" rows={4} placeholder="A short bio" value={bio} onChange={(e) => setBio(e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="iRating" htmlFor="iRating">
                <Input id="iRating" type="number" placeholder="e.g. 2500" value={iRating} onChange={(e) => setIRating(e.target.value)} />
              </Field>
              <Field label="Grad year" htmlFor="gradYear">
                <Input id="gradYear" type="number" placeholder="e.g. 2027" value={gradYear} onChange={(e) => setGradYear(e.target.value)} />
              </Field>
              <Field label="Major" htmlFor="major">
                <Input id="major" placeholder="e.g. Computer Science" value={major} onChange={(e) => setMajor(e.target.value)} />
              </Field>
            </div>
          </FormSection>

          <Divider />

          <FormSection title="Links" description="External links on the driver profile.">
            <FieldGrid>
              <Field label="Website" htmlFor="website">
                <Input id="website" type="url" placeholder="https://example.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </Field>
              <Field label="Instagram" htmlFor="instagram">
                <Input id="instagram" type="url" placeholder="https://instagram.com/handle" value={instagram} onChange={(e) => setInstagram(e.target.value)} />
              </Field>
              <Field label="Twitch" htmlFor="twitch">
                <Input id="twitch" type="url" placeholder="https://twitch.tv/handle" value={twitch} onChange={(e) => setTwitch(e.target.value)} />
              </Field>
              <Field label="YouTube" htmlFor="youtube">
                <Input id="youtube" type="url" placeholder="https://youtube.com/@channel" value={youtube} onChange={(e) => setYoutube(e.target.value)} />
              </Field>
            </FieldGrid>
          </FormSection>

          <Divider />

          <FormSection title="Roles" description="Officer and admin open the admin console. The others are badges on the site.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {allRoles.map((role) => {
                const staffOnly = STAFF_ROLES.includes(role.key) && !viewerIsAdmin
                return (
                  <CheckboxField
                    key={role.id}
                    id={`role-${role.key}`}
                    checked={selectedRoleKeys.includes(role.key)}
                    onChange={() => handleRoleToggle(role.key)}
                    disabled={staffOnly}
                    label={ROLE_LABEL[role.key as RoleCode] ?? role.key}
                    description={staffOnly ? "Only admins can change this." : role.description || undefined}
                  />
                )
              })}
            </div>
            <Field label="Officer title" htmlFor="officerTitle" hint="Shown on their officer badge, e.g. President or Treasurer.">
              <Input id="officerTitle" placeholder="e.g. President, Treasurer" value={officerTitle} onChange={(e) => setOfficerTitle(e.target.value)} className="sm:max-w-sm" />
            </Field>
          </FormSection>

          <Divider />

          <FormSection title="Membership" description="LSR member, alumni or partner.">
            <FieldGrid>
              <Field label="Tier" htmlFor="tier">
                <Select id="tier" value={selectedTierKey} onChange={(e) => setSelectedTierKey(e.target.value)}>
                  {allTiers.map((tier) => (
                    <option key={tier.key} value={tier.key}>
                      {tier.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {showValidTo && (
                <Field label="Valid until" htmlFor="validTo" hint="Leave blank for no end date.">
                  <Input id="validTo" type="date" value={validToDate} onChange={(e) => setValidToDate(e.target.value)} />
                  <div className="flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" onClick={() => setValidToDate(format(addMonths(new Date(), 6), "yyyy-MM-dd"))}>
                      +6 months
                    </Button>
                    <Button type="button" size="sm" onClick={() => setValidToDate(format(addMonths(new Date(), 12), "yyyy-MM-dd"))}>
                      +1 year
                    </Button>
                  </div>
                </Field>
              )}
            </FieldGrid>
          </FormSection>
        </PanelBody>
        <PanelFooter>
          <FormActions note="Changes are recorded in the audit log." className="w-full">
            <Button type="submit" variant="primary" pending={isPending} disabled={locked}>
              Save changes
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
