import {
  DuplicateIdempotencyKeyError,
  type AppendAuditEventRequest,
  type AuditEvent,
  type CreditMutationAuditPayload,
} from '../../models/AuditEvent.js';
import type { AuditEventRepository } from '../interfaces/AuditEventRepository.js';
import type { DbClient } from '../../db/client.js';

interface EventRow {
  id: string;
  event_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: CreditMutationAuditPayload | string | null;
  idempotency_key: string | null;
  created_at: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === '23505';
}

function parsePayload(raw: EventRow['payload']): CreditMutationAuditPayload {
  if (raw && typeof raw === 'object') {
    return raw;
  }
  if (typeof raw === 'string') {
    return JSON.parse(raw) as CreditMutationAuditPayload;
  }
  return {
    action: 'draw',
    walletAddress: '',
    amount: '0',
    appliedAmount: '0',
    utilizedBefore: '0',
    utilizedAfter: '0',
  };
}

export class PostgresAuditEventRepository implements AuditEventRepository {
  constructor(private client: DbClient) {}

  async append(request: AppendAuditEventRequest): Promise<AuditEvent> {
    const query = `
      INSERT INTO events (event_type, aggregate_type, aggregate_id, payload, idempotency_key)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, event_type, aggregate_type, aggregate_id, payload, idempotency_key, created_at
    `;
    try {
      const result = await this.client.query(query, [
        request.eventType,
        request.aggregateType,
        request.aggregateId,
        request.payload,
        request.idempotencyKey ?? null,
      ]);
      return this.toModel(result.rows[0] as EventRow);
    } catch (error) {
      if (request.idempotencyKey && isUniqueViolation(error)) {
        throw new DuplicateIdempotencyKeyError(request.idempotencyKey);
      }
      throw error;
    }
  }

  async findByIdempotencyKey(key: string): Promise<AuditEvent | null> {
    const result = await this.client.query(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, idempotency_key, created_at
       FROM events
       WHERE idempotency_key = $1`,
      [key],
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.toModel(result.rows[0] as EventRow);
  }

  async listByAggregate(aggregateType: string, aggregateId: string): Promise<AuditEvent[]> {
    const result = await this.client.query(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, idempotency_key, created_at
       FROM events
       WHERE aggregate_type = $1 AND aggregate_id = $2
       ORDER BY created_at ASC, id ASC`,
      [aggregateType, aggregateId],
    );
    return (result.rows as EventRow[]).map((row) => this.toModel(row));
  }

  private toModel(row: EventRow): AuditEvent {
    return {
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type ?? '',
      aggregateId: row.aggregate_id ?? '',
      payload: parsePayload(row.payload),
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
    };
  }
}
