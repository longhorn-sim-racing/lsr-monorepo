import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { UsersConsole, type MemberRow } from "@/components/admin/users-console"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Members" }

export default async function AdminUsersPage() {
  await requireOfficerPage()

  const [users, allRoles, allTiers] = await Promise.all([
    prisma.user.findMany({
      where: { status: { not: "deleted" } },
      include: {
        roles: { include: { role: true } },
        memberships: { include: { tier: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.role.findMany(),
    prisma.membershipTier.findMany(),
  ])

  // Only what the list shows, so the page doesn't ship whole user rows to the browser.
  const now = new Date()
  const rows: MemberRow[] = users.map((user) => {
    const active = user.memberships.find((m) => !m.validTo || m.validTo > now)
    return {
      id: user.id,
      displayName: user.displayName,
      handle: user.handle,
      email: user.email,
      eid: user.eid,
      avatarUrl: user.avatarUrl,
      officerTitle: user.officerTitle,
      status: user.status,
      createdAt: user.createdAt,
      roleKeys: user.roles.map((r) => r.role.key),
      membership: active ? { tierKey: active.tier.key, label: active.tier.label, validTo: active.validTo } : null,
    }
  })

  const staff = rows.filter((row) => row.roleKeys.includes("admin") || row.roleKeys.includes("officer")).length

  return (
    <>
      <PageHeader
        title="Members"
        description={`${rows.length} ${rows.length === 1 ? "member" : "members"} · ${staff} with admin access. Open a member to change their profile, roles or membership.`}
      />
      <UsersConsole
        rows={rows}
        roles={allRoles.map((role) => role.key)}
        tiers={allTiers.map((tier) => ({ key: tier.key, label: tier.label }))}
      />
    </>
  )
}
