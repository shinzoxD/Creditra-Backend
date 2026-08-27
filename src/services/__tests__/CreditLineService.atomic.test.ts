/**
 * Atomic draw/repay tests.
 *
 * Covers the issue #301 contract:
 * - no partial state after a failed mutation
 * - audit records match the committed utilized balance
 * - repeated repayment is deterministic and safe (floor at 0, idempotent keys)
 * - injected database failures roll back
 * - concurrent repayments serialize without going negative
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreditLineService } from '../CreditLineService.js';
import { InMemoryCreditLineRepository } from '../../repositories/memory/InMemoryCreditLineRepository.js';
import { InMemoryTransactionRepository } from '../../repositories/memory/InMemoryTransactionRepository.js';
import { InMemoryAuditEventRepository } from '../../repositories/memory/InMemoryAuditEventRepository.js';
import type { TransactionRepository } from '../../repositories/interfaces/TransactionRepository.js';
import type { AuditEventRepository } from '../../repositories/interfaces/AuditEventRepository.js';
import type { CreditLineRepository } from '../../repositories/interfaces/CreditLineRepository.js';
import { CreditLineStatus, type CreditLine } from '../../models/CreditLine.js';
import { TransactionStatus, TransactionType } from '../../models/Transaction.js';
import {
  DRAW_CONFIRMED_EVENT,
  DuplicateIdempotencyKeyError,
  REPAY_CONFIRMED_EVENT,
  type AuditEvent,
} from '../../models/AuditEvent.js';
import type { TransactionRunner } from '../../db/transaction.js';
import type { DbClient } from '../../db/client.js';
import { createDbTransactionRunner } from '../../db/transaction.js';

const WALLET = 'GBAHQCUPC7G2B4D2F2I2K2M2O2Q2S2U2W2Y2A2C2E2G2I2K2M2O2Q2S1';
const OTHER = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCX';

function createSnapshotRunner(
  lines: InMemoryCreditLineRepository,
  ledger: InMemoryTransactionRepository,
  audit: InMemoryAuditEventRepository,
): TransactionRunner {
  return async (work) => {
    const lineSnap = lines.exportState();
    const ledgerSnap = ledger.exportState();
    const auditSnap = audit.exportState();
    try {
      return await work();
    } catch (error) {
      lines.importState(lineSnap);
      ledger.importState(ledgerSnap);
      audit.importState(auditSnap);
      throw error;
    }
  };
}

async function seedLine(
  lines: InMemoryCreditLineRepository,
  utilized = '0',
  creditLimit = '1000',
): Promise<CreditLine> {
  const created = await lines.create({
    walletAddress: WALLET,
    creditLimit,
    interestRateBps: 500,
  });
  if (utilized === '0') {
    return created;
  }
  const updated = await lines.update(created.id, { utilized });
  if (!updated) {
    throw new Error('failed to seed utilized');
  }
  return updated;
}

function wrapLedgerFailAfterWrite(
  inner: InMemoryTransactionRepository,
): TransactionRepository {
  return {
    create: async (request) => {
      await inner.create(request);
      throw new Error('injected ledger failure');
    },
    findById: (id) => inner.findById(id),
    findByCreditLineId: (id, offset, limit) => inner.findByCreditLineId(id, offset, limit),
    findByWalletAddress: (w, offset, limit) => inner.findByWalletAddress(w, offset, limit),
    updateStatus: (id, status, processedAt) => inner.updateStatus(id, status, processedAt),
    findAll: (offset, limit) => inner.findAll(offset, limit),
    count: () => inner.count(),
    findByStatus: (status, offset, limit) => inner.findByStatus(status, offset, limit),
  };
}

function wrapAuditFailAfterWrite(
  inner: InMemoryAuditEventRepository,
): AuditEventRepository {
  return {
    append: async (request) => {
      await inner.append(request);
      throw new Error('injected audit failure');
    },
    findByIdempotencyKey: (key) => inner.findByIdempotencyKey(key),
    listByAggregate: (type, id) => inner.listByAggregate(type, id),
  };
}

function wrapStateFailAfterWrite(
  inner: InMemoryCreditLineRepository,
): CreditLineRepository {
  return {
    create: (req) => inner.create(req),
    findById: (id) => inner.findById(id),
    lockById: (id) => inner.lockById(id),
    findByWalletAddress: (w) => inner.findByWalletAddress(w),
    findAll: (offset, limit) => inner.findAll(offset, limit),
    findAllWithCursor: (cursor, limit) => inner.findAllWithCursor(cursor, limit),
    update: async (id, request) => {
      await inner.update(id, request);
      throw new Error('injected state failure');
    },
    delete: (id) => inner.delete(id),
    exists: (id) => inner.exists(id),
    count: () => inner.count(),
  };
}

describe('CreditLineService atomic draw/repay', () => {
  let lines: InMemoryCreditLineRepository;
  let ledger: InMemoryTransactionRepository;
  let audit: InMemoryAuditEventRepository;
  let service: CreditLineService;

  beforeEach(() => {
    lines = new InMemoryCreditLineRepository();
    ledger = new InMemoryTransactionRepository();
    audit = new InMemoryAuditEventRepository();
    service = new CreditLineService(lines, {
      transactionRepository: ledger,
      auditEventRepository: audit,
      runInTransaction: createSnapshotRunner(lines, ledger, audit),
    });
  });

  describe('happy path', () => {
    it('draw updates utilized, writes a borrow ledger row, and audits the new balance', async () => {
      const line = await seedLine(lines);

      const updated = await service.draw(line.id, WALLET, '250');

      expect(updated.utilized).toBe('250');
      const persisted = await lines.findById(line.id);
      expect(persisted?.utilized).toBe('250');

      const txs = await ledger.findByCreditLineId(line.id);
      expect(txs).toHaveLength(1);
      expect(txs[0]?.type).toBe(TransactionType.BORROW);
      expect(txs[0]?.amount).toBe('250');

      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(DRAW_CONFIRMED_EVENT);
      expect(events[0]?.payload).toMatchObject({
        action: 'draw',
        amount: '250',
        appliedAmount: '250',
        utilizedBefore: '0',
        utilizedAfter: '250',
      });
      expect(events[0]?.payload.utilizedAfter).toBe(persisted?.utilized);
    });

    it('repay reduces utilized, writes a repay ledger row, and audits the new balance', async () => {
      const line = await seedLine(lines, '400');

      const updated = await service.repay(line.id, WALLET, '150');

      expect(updated.utilized).toBe('250');
      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events[0]?.eventType).toBe(REPAY_CONFIRMED_EVENT);
      expect(events[0]?.payload).toMatchObject({
        action: 'repay',
        amount: '150',
        appliedAmount: '150',
        utilizedBefore: '400',
        utilizedAfter: '250',
      });
      expect(events[0]?.payload.utilizedAfter).toBe(updated.utilized);
    });
  });

  describe('authorization and validation', () => {
    it('rejects draw from a non-owner', async () => {
      const line = await seedLine(lines);
      await expect(service.draw(line.id, OTHER, '10')).rejects.toThrow('Unauthorized');
      expect(await ledger.count()).toBe(0);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(0);
    });

    it('rejects repay from a non-owner', async () => {
      const line = await seedLine(lines, '50');
      await expect(service.repay(line.id, OTHER, '10')).rejects.toThrow('Unauthorized');
      expect((await lines.findById(line.id))?.utilized).toBe('50');
      expect(await ledger.count()).toBe(0);
    });

    it('rejects draw on a suspended line without writing', async () => {
      const line = await seedLine(lines);
      await lines.update(line.id, { status: CreditLineStatus.SUSPENDED });
      await expect(service.draw(line.id, WALLET, '10')).rejects.toThrow('Credit line is not active');
      expect(await ledger.count()).toBe(0);
    });

    it('rejects over-limit draw without writing', async () => {
      const line = await seedLine(lines, '900');
      await expect(service.draw(line.id, WALLET, '101')).rejects.toThrow('Credit limit exceeded');
      expect((await lines.findById(line.id))?.utilized).toBe('900');
      expect(await ledger.count()).toBe(0);
    });

    it('rejects non-positive amounts', async () => {
      const line = await seedLine(lines, '10');
      await expect(service.draw(line.id, WALLET, '0')).rejects.toThrow('Draw amount must be greater than 0');
      await expect(service.repay(line.id, WALLET, '-5')).rejects.toThrow('Repay amount must be greater than 0');
      await expect(service.repay(line.id, WALLET, 'n/a')).rejects.toThrow('Repay amount must be greater than 0');
    });

    it('rejects draw when the credit line does not exist', async () => {
      await expect(service.draw('missing', WALLET, '10')).rejects.toThrow('Credit line not found');
    });

    it('treats a vanishing row during update as not found', async () => {
      const line = await seedLine(lines);
      const vanishing: CreditLineRepository = {
        create: (req) => lines.create(req),
        findById: (id) => lines.findById(id),
        lockById: (id) => lines.lockById(id),
        findByWalletAddress: (w) => lines.findByWalletAddress(w),
        findAll: (offset, limit) => lines.findAll(offset, limit),
        findAllWithCursor: (cursor, limit) => lines.findAllWithCursor(cursor, limit),
        update: async () => null,
        delete: (id) => lines.delete(id),
        exists: (id) => lines.exists(id),
        count: () => lines.count(),
      };
      const vanishingService = new CreditLineService(vanishing, {
        transactionRepository: ledger,
        auditEventRepository: audit,
        runInTransaction: createSnapshotRunner(lines, ledger, audit),
      });
      await expect(vanishingService.draw(line.id, WALLET, '10')).rejects.toThrow('Credit line not found');
      expect(await ledger.count()).toBe(0);
    });
  });

  describe('no partial state after injected failures', () => {
    it('rolls back state when the ledger write fails', async () => {
      const line = await seedLine(lines);
      const failing = new CreditLineService(lines, {
        transactionRepository: wrapLedgerFailAfterWrite(ledger),
        auditEventRepository: audit,
        runInTransaction: createSnapshotRunner(lines, ledger, audit),
      });

      await expect(failing.draw(line.id, WALLET, '100')).rejects.toThrow('injected ledger failure');

      expect((await lines.findById(line.id))?.utilized).toBe('0');
      expect(await ledger.count()).toBe(0);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(0);
    });

    it('rolls back state and ledger when the audit write fails', async () => {
      const line = await seedLine(lines);
      const failing = new CreditLineService(lines, {
        transactionRepository: ledger,
        auditEventRepository: wrapAuditFailAfterWrite(audit),
        runInTransaction: createSnapshotRunner(lines, ledger, audit),
      });

      await expect(failing.draw(line.id, WALLET, '100')).rejects.toThrow('injected audit failure');

      expect((await lines.findById(line.id))?.utilized).toBe('0');
      expect(await ledger.count()).toBe(0);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(0);
    });

    it('leaves no ledger or audit row when the state write fails', async () => {
      const durableLines = new InMemoryCreditLineRepository();
      const line = await seedLine(durableLines);
      const failing = new CreditLineService(wrapStateFailAfterWrite(durableLines), {
        transactionRepository: ledger,
        auditEventRepository: audit,
        runInTransaction: createSnapshotRunner(durableLines, ledger, audit),
      });

      await expect(failing.repay(line.id, WALLET, '10')).rejects.toThrow('injected state failure');

      expect(await ledger.count()).toBe(0);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(0);
    });

    it('rolls back repay the same way as draw when the ledger write fails', async () => {
      const line = await seedLine(lines, '200');
      const failing = new CreditLineService(lines, {
        transactionRepository: wrapLedgerFailAfterWrite(ledger),
        auditEventRepository: audit,
        runInTransaction: createSnapshotRunner(lines, ledger, audit),
      });

      await expect(failing.repay(line.id, WALLET, '50')).rejects.toThrow('injected ledger failure');

      expect((await lines.findById(line.id))?.utilized).toBe('200');
      expect(await ledger.count()).toBe(0);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(0);
    });
  });

  describe('audit records match final balances exactly', () => {
    it('each committed audit utilizedAfter equals the persisted line after that mutation', async () => {
      const line = await seedLine(lines);

      const afterDraw = await service.draw(line.id, WALLET, '300');
      const afterRepay = await service.repay(line.id, WALLET, '80');

      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events.map((e) => e.payload.utilizedAfter)).toEqual(['300', '220']);
      expect(events[0]?.payload.utilizedAfter).toBe(afterDraw.utilized);
      expect(events[1]?.payload.utilizedAfter).toBe(afterRepay.utilized);
      expect((await lines.findById(line.id))?.utilized).toBe(events[1]?.payload.utilizedAfter);
    });

    it('does not persist an audit row whose utilizedAfter disagrees with the line', async () => {
      const line = await seedLine(lines, '100');
      await service.repay(line.id, WALLET, '100');
      const events = await audit.listByAggregate('credit_line', line.id);
      const persisted = await lines.findById(line.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.utilizedAfter).toBe('0');
      expect(persisted?.utilized).toBe('0');
      expect(events[0]?.payload.utilizedAfter).toBe(persisted?.utilized);
    });
  });

  describe('repeated repayment is deterministic and safe', () => {
    it('floors utilized at 0 on over-repayment and records appliedAmount', async () => {
      const line = await seedLine(lines, '40');
      const updated = await service.repay(line.id, WALLET, '100');
      expect(updated.utilized).toBe('0');

      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events[0]?.payload.appliedAmount).toBe('40');
      expect(events[0]?.payload.amount).toBe('100');
      expect(events[0]?.payload.utilizedAfter).toBe('0');
    });

    it('a second repay on a zero-utilized line stays at 0', async () => {
      const line = await seedLine(lines, '10');
      await service.repay(line.id, WALLET, '10');
      const again = await service.repay(line.id, WALLET, '25');
      expect(again.utilized).toBe('0');

      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events).toHaveLength(2);
      expect(events[1]?.payload.appliedAmount).toBe('0');
      expect(events[1]?.payload.utilizedBefore).toBe('0');
      expect(events[1]?.payload.utilizedAfter).toBe('0');
      expect(events.every((e) => parseFloat(e.payload.utilizedAfter) >= 0)).toBe(true);
    });

    it('replays with the same idempotency key do not double-apply', async () => {
      const line = await seedLine(lines, '80');
      const first = await service.repay(line.id, WALLET, '30', { idempotencyKey: 'repay-1' });
      const second = await service.repay(line.id, WALLET, '30', { idempotencyKey: 'repay-1' });

      expect(first.utilized).toBe('50');
      expect(second.utilized).toBe('50');
      expect(await ledger.count()).toBe(1);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(1);
    });

    it('distinct idempotency keys still apply sequentially', async () => {
      const line = await seedLine(lines, '80');
      await service.repay(line.id, WALLET, '30', { idempotencyKey: 'a' });
      await service.repay(line.id, WALLET, '30', { idempotencyKey: 'b' });
      expect((await lines.findById(line.id))?.utilized).toBe('20');
      expect(await ledger.count()).toBe(2);
    });

    it('returns the committed line when append races on the unique idempotency key', async () => {
      const line = await seedLine(lines, '80');
      const racingAudit: AuditEventRepository = {
        append: async () => {
          throw new DuplicateIdempotencyKeyError('race-key');
        },
        findByIdempotencyKey: async () => null,
        listByAggregate: (type, id) => audit.listByAggregate(type, id),
      };
      const racing = new CreditLineService(lines, {
        transactionRepository: ledger,
        auditEventRepository: racingAudit,
        runInTransaction: createSnapshotRunner(lines, ledger, audit),
      });

      const result = await racing.repay(line.id, WALLET, '20', { idempotencyKey: 'race-key' });
      expect(result.utilized).toBe('80');
      expect(await ledger.count()).toBe(0);
    });

    it('surfaces not-found when a duplicate-key race happens after the line is deleted', async () => {
      const ghost: CreditLine = {
        id: 'cl-gone',
        walletAddress: WALLET,
        creditLimit: '100',
        availableCredit: '100',
        utilized: '10',
        interestRateBps: 0,
        status: CreditLineStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const missing: CreditLineRepository = {
        create: (req) => lines.create(req),
        findById: async () => null,
        lockById: async () => ghost,
        findByWalletAddress: (w) => lines.findByWalletAddress(w),
        findAll: (offset, limit) => lines.findAll(offset, limit),
        findAllWithCursor: (cursor, limit) => lines.findAllWithCursor(cursor, limit),
        update: async () => ghost,
        delete: (id) => lines.delete(id),
        exists: (id) => lines.exists(id),
        count: () => lines.count(),
      };
      const racingAudit: AuditEventRepository = {
        append: async () => {
          throw new DuplicateIdempotencyKeyError('gone');
        },
        findByIdempotencyKey: async () => null,
        listByAggregate: (type, id) => audit.listByAggregate(type, id),
      };
      const racing = new CreditLineService(missing, {
        transactionRepository: ledger,
        auditEventRepository: racingAudit,
      });
      await expect(
        racing.repay('cl-gone', WALLET, '10', { idempotencyKey: 'gone' }),
      ).rejects.toThrow('Credit line not found');
    });

    it('returns not-found when an idempotent replay cannot load the line', async () => {
      const missing: CreditLineRepository = {
        create: (req) => lines.create(req),
        findById: async () => null,
        lockById: async () => null,
        findByWalletAddress: (w) => lines.findByWalletAddress(w),
        findAll: (offset, limit) => lines.findAll(offset, limit),
        findAllWithCursor: (cursor, limit) => lines.findAllWithCursor(cursor, limit),
        update: async () => null,
        delete: (id) => lines.delete(id),
        exists: (id) => lines.exists(id),
        count: () => lines.count(),
      };
      const existingAudit: AuditEventRepository = {
        append: (req) => audit.append(req),
        findByIdempotencyKey: async () => ({
          id: 'evt',
          eventType: REPAY_CONFIRMED_EVENT,
          aggregateType: 'credit_line',
          aggregateId: 'cl-1',
          payload: {
            action: 'repay',
            walletAddress: WALLET,
            amount: '10',
            appliedAmount: '10',
            utilizedBefore: '10',
            utilizedAfter: '0',
          },
          createdAt: new Date(),
        }),
        listByAggregate: (type, id) => audit.listByAggregate(type, id),
      };
      const replay = new CreditLineService(missing, {
        auditEventRepository: existingAudit,
      });
      await expect(
        replay.repay('cl-1', WALLET, '10', { idempotencyKey: 'replay' }),
      ).rejects.toThrow('Credit line not found');
    });
  });

  describe('concurrent calls', () => {
    it('concurrent repayments never go negative and sum of applied equals start utilized', async () => {
      const line = await seedLine(lines, '100');

      const results = await Promise.all([
        service.repay(line.id, WALLET, '30'),
        service.repay(line.id, WALLET, '30'),
        service.repay(line.id, WALLET, '30'),
        service.repay(line.id, WALLET, '30'),
      ]);

      const final = await lines.findById(line.id);
      expect(final?.utilized).toBe('0');
      expect(results.every((row) => parseFloat(row.utilized) >= 0)).toBe(true);

      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events).toHaveLength(4);
      const applied = events.reduce((sum, event) => sum + parseFloat(event.payload.appliedAmount), 0);
      expect(applied).toBe(100);
      expect(events.every((event) => parseFloat(event.payload.utilizedAfter) >= 0)).toBe(true);
      expect(events.at(-1)?.payload.utilizedAfter).toBe(final?.utilized);
      assertSerializableAuditChain(events);
    });

    it('concurrent draws cannot exceed the credit limit', async () => {
      const line = await seedLine(lines, '0', '100');

      const outcomes = await Promise.allSettled([
        service.draw(line.id, WALLET, '60'),
        service.draw(line.id, WALLET, '60'),
        service.draw(line.id, WALLET, '60'),
      ]);

      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(2);
      expect((await lines.findById(line.id))?.utilized).toBe('60');
      expect(await ledger.count()).toBe(1);
      const events = await audit.listByAggregate('credit_line', line.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.utilizedAfter).toBe('60');
    });

    it('concurrent identical idempotency keys apply the repayment once', async () => {
      const line = await seedLine(lines, '90');

      const [a, b] = await Promise.all([
        service.repay(line.id, WALLET, '40', { idempotencyKey: 'same' }),
        service.repay(line.id, WALLET, '40', { idempotencyKey: 'same' }),
      ]);

      expect(a.utilized).toBe('50');
      expect(b.utilized).toBe('50');
      expect(await ledger.count()).toBe(1);
      expect(await audit.listByAggregate('credit_line', line.id)).toHaveLength(1);
    });
  });
});

function assertSerializableAuditChain(events: AuditEvent[]): void {
  let expectedBefore = events[0]?.payload.utilizedBefore;
  for (const event of events) {
    expect(event.payload.utilizedBefore).toBe(expectedBefore);
    const next =
      parseFloat(event.payload.utilizedBefore) -
      (event.payload.action === 'repay' ? parseFloat(event.payload.appliedAmount) : -parseFloat(event.payload.appliedAmount));
    expect(event.payload.utilizedAfter).toBe(String(next === 0 ? 0 : next));
    expectedBefore = event.payload.utilizedAfter;
  }
}

describe('CreditLineService + createDbTransactionRunner (SQL control flow)', () => {
  const line: CreditLine = {
    id: 'cl-1',
    walletAddress: WALLET,
    creditLimit: '1000',
    availableCredit: '1000',
    utilized: '0',
    interestRateBps: 500,
    status: CreditLineStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function mockRepos(overrides: {
    update?: CreditLineRepository['update'];
    createTx?: TransactionRepository['create'];
    append?: AuditEventRepository['append'];
  } = {}): {
    creditLines: CreditLineRepository;
    transactions: TransactionRepository;
    audits: AuditEventRepository;
  } {
    const creditLines: CreditLineRepository = {
      create: vi.fn(),
      findById: vi.fn(async () => line),
      lockById: vi.fn(async () => line),
      findByWalletAddress: vi.fn(),
      findAll: vi.fn(),
      findAllWithCursor: vi.fn(),
      update: overrides.update ?? vi.fn(async (_id, req) => ({
        ...line,
        utilized: req.utilized ?? line.utilized,
      })),
      delete: vi.fn(),
      exists: vi.fn(),
      count: vi.fn(),
    };
    const transactions: TransactionRepository = {
      create: overrides.createTx ?? vi.fn(async (req) => ({
        id: 'tx-1',
        creditLineId: req.creditLineId,
        walletAddress: WALLET,
        amount: req.amount,
        type: req.type,
        status: TransactionStatus.PENDING,
        createdAt: new Date(),
      })),
      findById: vi.fn(),
      findByCreditLineId: vi.fn(),
      findByWalletAddress: vi.fn(),
      updateStatus: vi.fn(),
      findAll: vi.fn(),
      count: vi.fn(),
      findByStatus: vi.fn(),
    };
    const audits: AuditEventRepository = {
      append: overrides.append ?? vi.fn(async (req) => ({
        id: 'evt-1',
        eventType: req.eventType,
        aggregateType: req.aggregateType,
        aggregateId: req.aggregateId,
        payload: req.payload,
        idempotencyKey: req.idempotencyKey,
        createdAt: new Date(),
      })),
      findByIdempotencyKey: vi.fn(async () => null),
      listByAggregate: vi.fn(async () => []),
    };
    return { creditLines, transactions, audits };
  }

  it('issues BEGIN … COMMIT around a successful multi-write draw', async () => {
    const statements: string[] = [];
    const client: DbClient = {
      async query(text: string) {
        statements.push(text.trim().toUpperCase().split(/\s+/)[0] ?? text);
        return { rows: [{ id: 'x' }] };
      },
      async end() {
        /* no-op */
      },
    };
    const { creditLines, transactions, audits } = mockRepos();
    const service = new CreditLineService(creditLines, {
      transactionRepository: transactions,
      auditEventRepository: audits,
      runInTransaction: createDbTransactionRunner(client),
    });

    await service.draw('cl-1', WALLET, '10');

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
  });

  it('issues BEGIN … ROLLBACK when a mid-flow write throws', async () => {
    const statements: string[] = [];
    const client: DbClient = {
      async query(text: string) {
        statements.push(text.trim().toUpperCase().split(/\s+/)[0] ?? text);
        return { rows: [] };
      },
      async end() {
        /* no-op */
      },
    };
    const { creditLines, transactions, audits } = mockRepos({
      append: vi.fn(async () => {
        throw new Error('injected mid-flow failure');
      }),
    });
    const service = new CreditLineService(creditLines, {
      transactionRepository: transactions,
      auditEventRepository: audits,
      runInTransaction: createDbTransactionRunner(client),
    });

    await expect(service.draw('cl-1', WALLET, '10')).rejects.toThrow('injected mid-flow failure');

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });
});
