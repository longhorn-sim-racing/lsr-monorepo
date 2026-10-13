# Admin UI

How the admin console (`/admin`) is built, for anyone adding or changing an admin page. The goal is a dense, consistent, professional tool: every page uses the same few parts, and nothing is styled one-off.

## Where things live

- **Shell:** `apps/platform/src/components/admin/shell/`. It holds the dark sidebar (a drawer on phones), the top bar with breadcrumbs, and the Ctrl K command menu. The sidebar groups live in `admin-nav.ts`; add new pages there.
- **Kit:** `apps/platform/src/components/admin/kit/`. Import everything from `@/components/admin/kit`.
- **Live gallery:** `/admin/kit` shows every kit component with sample data. Copy patterns from `app/admin/kit/gallery.tsx`.
- **Theme:** `app/globals.css` (`html:has(.admin-light)`). Admin pages are light; the public site stays dark. A dark admin theme can come later as a second set of values.

## Look

- Montserrat for text. Kanit (`font-display`) only for page titles, which `PageHeader` already does.
- Warm off-white background, white panels, warm gray borders. Orange is for the one primary action per view, the active nav item and highlights. Don't use orange for decoration.
- Use theme classes, never raw colors or white/black opacity:
  - surfaces: `bg-card`, `bg-background`, `bg-admin-surface`
  - borders: `border`, `border-admin-row`
  - text: `text-foreground`, `text-muted-foreground`, `text-admin-subtle`
  - status: `bg-tone-*` and `text-tone-*-foreground`, or just `<Badge tone>`
- Dense: 32px controls, 13px text in tables and forms.
- No uppercase or letter-spaced labels. No `font-mono` except for code, IDs and JSON. No `dark:` classes.

## Page anatomy

```tsx
export const metadata: Metadata = { title: "Events" } // the tab reads "Events | LSR Admin"

export default async function EventsPage() {
  await requireOfficerPage()   // every admin page checks access itself
  const events = await getAllEventsForAdmin()
  return (
    <>
      <PageHeader title="Events" description="7 events · 1 draft" actions={<Button variant="primary" asChild><Link href="/admin/events/new">New event</Link></Button>} />
      <EventsTable events={events} />
    </>
  )
}
```

Detail and edit pages pass `back={{ href: "/admin/events", label: "Events" }}` to `PageHeader`.

## Lists

- **Client lists:** use `DataTable` with `search`, sortable columns (`sortValue`), `filters`, `rowActions` and `rowHref` or `onRowClick`.
  - Put a real `<Link>` to the item in the first column, so keyboard users can open it.
  - Hide low-value columns on phones with `hideBelow`.
- **Server-paginated lists** (payments, audit) use the table pieces (`Table`, `THead`, `TH`, `TR`, `TD`) with `Pager`. Keep filters in the URL.
- **Filters:**
  - `Segmented` for one-of choices like All / Upcoming / Past.
  - `FilterMenu` to pick several values, like statuses or roles.
  - `Select` for long option lists.
- **Summaries above a list:** `StatRow` with `Stat`.
- **Empty lists** say why they're empty and offer the next step (`EmptyState`).

## Forms

- `Panel` holds the form, with `PanelHeader`, `PanelBody` and `PanelFooter`.
- Inside it, `FormSection` groups fields. Each field is a `Field` (label, hint, error) around `Input`, `Textarea`, `Select`, `MoneyInput`, `SwitchField` or `CheckboxField`. `FieldGrid` puts two fields per row.
- Buttons go in `FormActions` in the footer, with one primary button. The kit `Button` is a plain button by default; give the one that submits `type="submit"`.
- For quick edits, put the form in a side panel with `SplitLayout`. Long forms (like the event form) get their own page.
- Keep the existing server actions and their return shapes. Report success or failure with `toast`, and validation problems with `Field`'s `error`.
- Member pickers: `UserPicker` and `UserMultiPicker`. They search by name, handle, email or EID through `searchUsersForAdmin`.
- Times are Central (`America/Chicago`). Use the helpers in `lib/dates.ts`.

## Destructive actions

- Deletes and other actions you can't undo always confirm first.
  - In a row menu, give the item `destructive: { title, description }`.
  - Anywhere else, use `const confirm = useConfirm()`.
- Never use `window.confirm`, `prompt` or `alert`. Use `useConfirm`, `usePrompt` and `toast` instead.

## Phones

Every page must work at 390px wide:
- toolbars wrap;
- tables scroll sideways inside their card;
- side panels drop below the list;
- dialogs fit the screen.
