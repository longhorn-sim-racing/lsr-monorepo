// Shown inside the admin layout while a section loads, so the sidebar stays put
export default function AdminLoading() {
  return (
    <div role="status" className="animate-pulse">
      <span className="sr-only">Loading</span>
      <div className="mb-1.5 h-7 w-48 rounded bg-muted" />
      <div className="mb-4 h-4 w-72 max-w-full rounded bg-muted/70" />
      <div className="mb-3 h-8 w-full max-w-xs rounded-md bg-muted/70" />
      <div className="rounded-lg border bg-card">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-admin-row px-3 py-3 last:border-b-0">
            <div className="h-3.5 w-1/3 rounded bg-muted" />
            <div className="h-3.5 w-1/6 rounded bg-muted/70" />
            <div className="ml-auto h-3.5 w-16 rounded bg-muted/70" />
          </div>
        ))}
      </div>
    </div>
  )
}
