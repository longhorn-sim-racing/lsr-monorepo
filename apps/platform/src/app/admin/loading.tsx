// Shown inside the admin layout while a section loads, so the sidebar stays put
export default function AdminLoading() {
  return (
    <div role="status" className="animate-pulse space-y-4">
      <span className="sr-only">Loading</span>
      <div className="h-7 w-56 bg-white/10" />
      <div className="h-9 w-full max-w-md bg-white/[0.06]" />
      <div className="border border-white/10">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-white/5 px-4 py-3 last:border-b-0">
            <div className="h-4 w-1/3 bg-white/[0.08]" />
            <div className="h-4 w-1/6 bg-white/[0.05]" />
            <div className="ml-auto h-4 w-16 bg-white/[0.05]" />
          </div>
        ))}
      </div>
    </div>
  )
}
