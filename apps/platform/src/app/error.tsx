"use client"
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-muted-foreground mt-2">{error.message}</p>
      <button className="mt-4 rounded-md border px-3 py-2" onClick={() => reset()}>Try again</button>
    </div>
  )
}
