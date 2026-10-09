export default function RetiredPage() {
  return (
    <div className="mx-auto max-w-2xl p-8 space-y-4">
      <h1 className="text-2xl font-bold">Account retired</h1>
      <p className="text-muted-foreground">
        Your account has been marked as <strong>retired</strong>. Your driver page remains visible,
        but you’re signed out and can’t use member features. If you need to un-retire, contact an admin.
      </p>
    </div>
  )
}
