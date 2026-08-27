import type { AppendAuditEventRequest, AuditEvent } from '../../models/AuditEvent.js';

/**
 * Persistence for immutable credit-lifecycle audit events.
 *
 * Implementations must participate in the caller's open database transaction
 * (same {@link import('../../db/client.js').DbClient} session) so a failed
 * append rolls back the paired balance and ledger writes.
 */
export interface AuditEventRepository {
  /**
   * Append an audit event. Throws {@link import('../../models/AuditEvent.js').DuplicateIdempotencyKeyError}
   * when `idempotencyKey` collides with an existing row.
   */
  append(request: AppendAuditEventRequest): Promise<AuditEvent>;

  /** Lookup by unique idempotency key; `null` when unused. */
  findByIdempotencyKey(key: string): Promise<AuditEvent | null>;

  /** Time-ordered (oldest first) events for an aggregate. */
  listByAggregate(aggregateType: string, aggregateId: string): Promise<AuditEvent[]>;
}
