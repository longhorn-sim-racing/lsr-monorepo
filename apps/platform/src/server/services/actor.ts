/**
 * Who is making a change through a service (event, results, news): the officer whose id goes on the
 * audit entry. The admin actions pass `{ userId }` after their own guard. Jack's proposals pass the
 * officer who pressed Apply plus `auditMetadata` ({ via: "jack", proposalId, roomId, proposedFor }),
 * which is added to the entry's metadata so the audit log shows where the change came from.
 *
 * Services never check permissions themselves: the caller has already done that.
 */
export type ServiceActor = {
  userId: string;
  auditMetadata?: Record<string, unknown>;
};

/**
 * The audit entry's metadata with the actor's extra fields added. The service's own fields win on a
 * clash. Without extra fields it's exactly `metadata` (undefined stays undefined), so the admin pages
 * write the same entries they always have.
 */
export function withActorMetadata(actor: ServiceActor, metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!actor.auditMetadata) return metadata;
  return { ...actor.auditMetadata, ...metadata };
}
