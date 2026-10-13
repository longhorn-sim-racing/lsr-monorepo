"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { CellStack, DataTable, EmptyState, FilterMenu, RowActions, RowMenu, ToneText, type Column } from "@/components/admin/kit"
import { MemberAvatar } from "@/app/admin/users/_components/member-avatar"
import { MemberBadges } from "@/app/admin/users/_components/member-badges"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { ROLE_LABEL, type RoleCode } from "@/lib/roles"

export type MemberRow = {
  id: string
  displayName: string
  handle: string
  email: string
  eid: string | null
  avatarUrl: string | null
  officerTitle: string | null
  status: string
  createdAt: Date
  roleKeys: string[]
  /** The membership in force today, if any */
  membership: { tierKey: string; label: string; validTo: Date | null } | null
}

const NO_MEMBERSHIP = "__none"

const roleLabel = (key: string) => ROLE_LABEL[key as RoleCode] ?? key
const central = (date: Date, pattern: string) => formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)
const editHref = (row: MemberRow) => `/admin/users/${row.id}/edit`

const columns: Column<MemberRow>[] = [
  {
    id: "name",
    header: "Member",
    sortValue: (row) => row.displayName,
    cell: (row) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <MemberAvatar name={row.displayName} src={row.avatarUrl} />
        <CellStack
          primary={
            <Link href={editHref(row)} className="hover:underline">
              {row.displayName}
            </Link>
          }
          secondary={`@${row.handle}`}
        />
      </div>
    ),
  },
  {
    id: "email",
    header: "Email",
    hideBelow: "lg",
    sortValue: (row) => row.email,
    cell: (row) => (
      <CellStack primary={<span className="font-normal">{row.email}</span>} secondary={row.eid ? `EID ${row.eid}` : undefined} />
    ),
  },
  {
    id: "badges",
    header: "Badges",
    hideBelow: "md",
    cell: (row) => (
      <MemberBadges
        roles={row.roleKeys}
        activeTierKey={row.membership?.tierKey ?? null}
        officerTitle={row.officerTitle}
        status={row.status}
        empty={<span className="text-admin-subtle">—</span>}
      />
    ),
  },
  {
    id: "membership",
    header: "Membership",
    sortValue: (row) => row.membership?.label,
    cell: (row) =>
      row.membership ? (
        <CellStack
          primary={row.membership.label}
          secondary={row.membership.validTo ? `Until ${central(row.membership.validTo, "MMM yyyy")}` : "No end date"}
        />
      ) : (
        <ToneText>None</ToneText>
      ),
  },
  {
    id: "joined",
    header: "Joined",
    hideBelow: "sm",
    sortValue: (row) => row.createdAt,
    cell: (row) => <span className="whitespace-nowrap text-muted-foreground">{central(row.createdAt, "MMM d, yyyy")}</span>,
  },
]

export function UsersConsole({ rows, roles, tiers }: { rows: MemberRow[]; roles: string[]; tiers: { key: string; label: string }[] }) {
  const [roleFilter, setRoleFilter] = useState<string[]>([])
  const [tierFilter, setTierFilter] = useState<string[]>([])

  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          (roleFilter.length === 0 || row.roleKeys.some((key) => roleFilter.includes(key))) &&
          (tierFilter.length === 0 || tierFilter.includes(row.membership?.tierKey ?? NO_MEMBERSHIP)),
      ),
    [rows, roleFilter, tierFilter],
  )

  return (
    <DataTable
      rows={visible}
      columns={columns}
      getRowId={(row) => row.id}
      search={{
        placeholder: "Search name, handle, email or EID",
        text: (row) => `${row.displayName} ${row.handle} @${row.handle} ${row.email} ${row.eid ?? ""}`,
      }}
      filters={
        <>
          <FilterMenu label="Role" selected={roleFilter} onChange={setRoleFilter} options={roles.map((key) => ({ value: key, label: roleLabel(key) }))} />
          <FilterMenu
            label="Membership"
            selected={tierFilter}
            onChange={setTierFilter}
            options={[...tiers.map((tier) => ({ value: tier.key, label: tier.label })), { value: NO_MEMBERSHIP, label: "No membership" }]}
          />
        </>
      }
      rowHref={editHref}
      rowActions={(row) => (
        <RowActions>
          <RowMenu
            label={`More actions for ${row.displayName}`}
            items={[
              { label: "Edit member", href: editHref(row) },
              { label: "View public profile", href: `/drivers/${row.handle}`, external: true },
            ]}
          />
        </RowActions>
      )}
      initialSort={{ id: "name" }}
      noun={{ one: "member", many: "members" }}
      minWidth={360}
      empty={
        rows.length > 0 ? (
          <EmptyState title="No members match these filters" description="Clear the role or membership filter to see everyone." />
        ) : (
          <EmptyState title="No members yet" description="Members appear here the first time they sign in to the site." />
        )
      }
    />
  )
}
