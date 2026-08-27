import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbClient } from '../../../db/client.js';
import { PostgresAuditEventRepository } from '../PostgresAuditEventRepository.js';
import {
  DuplicateIdempotencyKeyError,
  DRAW_CONFIRMED_EVENT,
} from '../../../models/AuditEvent.js';

function createMockClient(overrides: Partial<DbClient> = {}): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const payload = {
  action: 'draw' as const,
  walletAddress: 'GTEST',
  amount: '10',
  appliedAmount: '10',
  utilizedBefore: '0',
  utilizedAfter: '10',
};

describe('PostgresAuditEventRepository', () => {
  let client: DbClient;
  let repository: PostgresAuditEventRepository;

  beforeEach(() => {
    client = createMockClient();
    repository = new PostgresAuditEventRepository(client);
  });

  it('inserts an event and maps the returned row', async () => {
    const now = new Date();
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'evt-1',
        event_type: DRAW_CONFIRMED_EVENT,
        aggregate_type: 'credit_line',
        aggregate_id: 'cl-1',
        payload,
        idempotency_key: 'k1',
        created_at: now,
      }],
    });

    const result = await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload,
      idempotencyKey: 'k1',
    });

    expect(result).toMatchObject({
      id: 'evt-1',
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateId: 'cl-1',
      payload,
      idempotencyKey: 'k1',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO events'),
      [DRAW_CONFIRMED_EVENT, 'credit_line', 'cl-1', payload, 'k1'],
    );
  });

  it('maps a unique-violation into DuplicateIdempotencyKeyError', async () => {
    const error = Object.assign(new Error('duplicate'), { code: '23505' });
    vi.mocked(client.query).mockRejectedValueOnce(error);

    await expect(
      repository.append({
        eventType: DRAW_CONFIRMED_EVENT,
        aggregateType: 'credit_line',
        aggregateId: 'cl-1',
        payload,
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
  });

  it('rethrows non-unique failures', async () => {
    vi.mocked(client.query).mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      repository.append({
        eventType: DRAW_CONFIRMED_EVENT,
        aggregateType: 'credit_line',
        aggregateId: 'cl-1',
        payload,
      }),
    ).rejects.toThrow('connection lost');
  });

  it('returns null when the idempotency key is unused', async () => {
    expect(await repository.findByIdempotencyKey('missing')).toBeNull();
  });

  it('parses a JSON-string payload on read', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'evt-1',
        event_type: DRAW_CONFIRMED_EVENT,
        aggregate_type: 'credit_line',
        aggregate_id: 'cl-1',
        payload: JSON.stringify(payload),
        idempotency_key: null,
        created_at: new Date(),
      }],
    });

    const result = await repository.findByIdempotencyKey('k1');
    expect(result?.payload.utilizedAfter).toBe('10');
  });

  it('maps a null payload to a zeroed default', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'evt-empty',
        event_type: DRAW_CONFIRMED_EVENT,
        aggregate_type: null,
        aggregate_id: null,
        payload: null,
        idempotency_key: null,
        created_at: new Date(),
      }],
    });

    const events = await repository.listByAggregate('credit_line', 'cl-1');
    expect(events[0]?.payload.utilizedAfter).toBe('0');
    expect(events[0]?.aggregateType).toBe('');
  });

  it('lists events for an aggregate', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'evt-1',
        event_type: DRAW_CONFIRMED_EVENT,
        aggregate_type: 'credit_line',
        aggregate_id: 'cl-1',
        payload,
        idempotency_key: null,
        created_at: new Date(),
      }],
    });

    const events = await repository.listByAggregate('credit_line', 'cl-1');
    expect(events).toHaveLength(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('aggregate_type = $1'),
      ['credit_line', 'cl-1'],
    );
  });
});
