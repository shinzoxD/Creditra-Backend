import { randomUUID } from 'crypto';
import {
  DuplicateIdempotencyKeyError,
  type AppendAuditEventRequest,
  type AuditEvent,
} from '../../models/AuditEvent.js';
import type { AuditEventRepository } from '../interfaces/AuditEventRepository.js';

export class InMemoryAuditEventRepository implements AuditEventRepository {
  private readonly events: Map<string, AuditEvent> = new Map();
  private readonly byIdempotencyKey: Map<string, string> = new Map();

  async append(request: AppendAuditEventRequest): Promise<AuditEvent> {
    if (request.idempotencyKey) {
      const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
      if (existingId) {
        throw new DuplicateIdempotencyKeyError(request.idempotencyKey);
      }
    }

    const event: AuditEvent = {
      id: randomUUID(),
      eventType: request.eventType,
      aggregateType: request.aggregateType,
      aggregateId: request.aggregateId,
      payload: { ...request.payload },
      idempotencyKey: request.idempotencyKey,
      createdAt: new Date(),
    };

    this.events.set(event.id, event);
    if (event.idempotencyKey) {
      this.byIdempotencyKey.set(event.idempotencyKey, event.id);
    }
    return event;
  }

  async findByIdempotencyKey(key: string): Promise<AuditEvent | null> {
    const id = this.byIdempotencyKey.get(key);
    if (!id) {
      return null;
    }
    return this.events.get(id) ?? null;
  }

  async listByAggregate(aggregateType: string, aggregateId: string): Promise<AuditEvent[]> {
    // Map iteration is insertion-ordered; keep that so concurrent tests can
    // reconstruct the serializable applied-amount chain even when Date.now()
    // collides across back-to-back writes.
    return Array.from(this.events.values()).filter(
      (event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId,
    );
  }

  /** Test helper. */
  clear(): void {
    this.events.clear();
    this.byIdempotencyKey.clear();
  }

  /** Test helper — snapshot for injected-failure rollback harnesses. */
  exportState(): AuditEvent[] {
    return Array.from(this.events.values()).map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
  }

  /** Test helper — restore a snapshot taken by {@link exportState}. */
  importState(events: AuditEvent[]): void {
    this.events.clear();
    this.byIdempotencyKey.clear();
    for (const event of events) {
      const copy: AuditEvent = { ...event, payload: { ...event.payload } };
      this.events.set(copy.id, copy);
      if (copy.idempotencyKey) {
        this.byIdempotencyKey.set(copy.idempotencyKey, copy.id);
      }
    }
  }
}
