import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { ExternalLink } from "lucide-react"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { Button, DetailList, PageHeader, Panel, PanelBody } from "@/components/admin/kit"
import { UserEditForm } from "@/components/admin/user-edit-form"
import { MemberAvatar } from "@/app/admin/users/_components/member-avatar"
import { MemberBadges } from "@/app/admin/users/_components/member-badges"
import { getActiveTierKey } from "@/lib/status-indicators"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { PurgeLinkedButton } from "@/app/admin/discord/purge-form"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Edit member" }

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending_verification: "Not verified yet",
  retired: "Retired",
  deleted: "Deleted",
}

export default async function AdminUserEditPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params

  const [user, allRoles, allTiers, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: true } },
        memberships: { include: { tier: true } },
      },
    }),
    prisma.role.findMany(),
    prisma.membershipTier.findMany(),
    getCachedSessionUser(),
  ])

  if (!user) notFound()

  const roleKeys = user.roles.map((r) => r.role.key)
  const activeTierKey = getActiveTierKey(user.memberships)
  const activeTier = user.memberships.find((m) => m.tier.key === activeTierKey)?.tier

  return (
    <>
      <PageHeader
        back={{ href: "/admin/users", label: "Members" }}
        title={user.displayName}
        description={`@${user.handle}`}
        actions={
          <Button asChild>
            <a href={`/drivers/${user.handle}`} target="_blank" rel="noreferrer">
              Public profile
              <ExternalLink aria-hidden />
            </a>
          </Button>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Panel className="lg:sticky lg:top-[60px] lg:order-2">
          <PanelBody className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <MemberAvatar name={user.displayName} src={user.avatarUrl} size="lg" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="truncate text-sm font-semibold">{user.displayName}</p>
                <MemberBadges
                  roles={roleKeys}
                  activeTierKey={activeTierKey}
                  officerTitle={user.officerTitle}
                  empty={<span className="text-xs text-admin-subtle">No badges</span>}
                />
              </div>
            </div>
            <DetailList
              items={[
                { label: "Email", value: user.email },
                { label: "UT EID", value: user.eid ? <span className="font-mono text-xs">{user.eid}</span> : <span className="text-admin-subtle">Not given</span> },
                { label: "Account", value: STATUS_LABEL[user.status] ?? user.status },
                { label: "Membership", value: activeTier?.label ?? <span className="text-admin-subtle">None</span> },
                {
                  label: "Discord",
                  value: user.discordUserId ? (
                    <span className="flex flex-col items-start gap-1.5">
                      <span>
                        @{user.discordUsername ?? "linked"}
                        {user.discordLinkedAt && <span className="text-admin-subtle"> since {formatInTimeZone(user.discordLinkedAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}</span>}
                      </span>
                      {session.roles.includes("admin") && <PurgeLinkedButton userId={user.id} username={user.discordUsername} />}
                    </span>
                  ) : (
                    <span className="text-admin-subtle">Not linked</span>
                  ),
                },
                { label: "Joined", value: formatInTimeZone(user.createdAt, DEFAULT_TIMEZONE, "MMM d, yyyy") },
                { label: "User ID", value: <span className="font-mono text-xs">{user.id}</span> },
              ]}
            />
          </PanelBody>
        </Panel>

        <UserEditForm user={user} allRoles={allRoles} allTiers={allTiers} viewerIsAdmin={session.roles.includes("admin")} />
      </div>
    </>
  )
}
