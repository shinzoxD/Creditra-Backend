import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditEventRepository } from '../InMemoryAuditEventRepository.js';
import {
  DuplicateIdempotencyKeyError,
  DRAW_CONFIRMED_EVENT,
  REPAY_CONFIRMED_EVENT,
} from '../../../models/AuditEvent.js';

function payload(utilizedAfter: string) {
  return {
    action: 'draw' as const,
    walletAddress: 'GTEST',
    amount: '10',
    appliedAmount: '10',
    utilizedBefore: '0',
    utilizedAfter,
  };
}

describe('InMemoryAuditEventRepository', () => {
  let repository: InMemoryAuditEventRepository;

  beforeEach(() => {
    repository = new InMemoryAuditEventRepository();
  });

  it('appends and lists events for an aggregate in insertion order', async () => {
    await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: payload('10'),
    });
    await repository.append({
      eventType: REPAY_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: { ...payload('5'), action: 'repay' },
    });
    await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-other',
      payload: payload('1'),
    });

    const events = await repository.listByAggregate('credit_line', 'cl-1');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.utilizedAfter)).toEqual(['10', '5']);
  });

  it('looks up events by idempotency key', async () => {
    const created = await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: payload('10'),
      idempotencyKey: 'k1',
    });

    expect(await repository.findByIdempotencyKey('k1')).toEqual(created);
    expect(await repository.findByIdempotencyKey('missing')).toBeNull();
  });

  it('rejects a duplicate idempotency key', async () => {
    await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: payload('10'),
      idempotencyKey: 'k1',
    });

    await expect(
      repository.append({
        eventType: DRAW_CONFIRMED_EVENT,
        aggregateType: 'credit_line',
        aggregateId: 'cl-1',
        payload: payload('20'),
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
  });

  it('exportState / importState round-trips rows', async () => {
    await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: payload('10'),
      idempotencyKey: 'k1',
    });
    const snap = repository.exportState();
    await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: payload('20'),
    });
    repository.importState(snap);
    expect(await repository.listByAggregate('credit_line', 'cl-1')).toHaveLength(1);
    expect(await repository.findByIdempotencyKey('k1')).not.toBeNull();
  });

  it('clear wipes all rows', async () => {
    await repository.append({
      eventType: DRAW_CONFIRMED_EVENT,
      aggregateType: 'credit_line',
      aggregateId: 'cl-1',
      payload: payload('10'),
    });
    repository.clear();
    expect(await repository.listByAggregate('credit_line', 'cl-1')).toEqual([]);
  });
});
