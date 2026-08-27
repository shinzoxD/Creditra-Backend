import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbClient } from '../../../db/client.js';
import { PostgresTransactionRepository } from '../PostgresTransactionRepository.js';
import { TransactionStatus, TransactionType } from '../../../models/Transaction.js';

function createMockClient(overrides: Partial<DbClient> = {}): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PostgresTransactionRepository', () => {
  let client: DbClient;
  let repository: PostgresTransactionRepository;

  beforeEach(() => {
    client = createMockClient();
    repository = new PostgresTransactionRepository(client);
  });

  it('inserts a ledger row and returns the mapped transaction', async () => {
    const now = new Date();
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'tx-1',
        credit_line_id: 'cl-1',
        type: TransactionType.BORROW,
        amount: '100',
        currency: 'USDC',
        created_at: now,
      }],
    });

    const result = await repository.create({
      creditLineId: 'cl-1',
      amount: '100',
      type: TransactionType.BORROW,
      blockchainTxHash: 'hash',
    });

    expect(result).toMatchObject({
      id: 'tx-1',
      creditLineId: 'cl-1',
      amount: '100',
      type: TransactionType.BORROW,
      status: TransactionStatus.PENDING,
      blockchainTxHash: 'hash',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO transactions'),
      ['cl-1', TransactionType.BORROW, '100', 'USDC'],
    );
  });

  it('returns null from findById when missing', async () => {
    expect(await repository.findById('missing')).toBeNull();
  });

  it('counts rows', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({ rows: [{ count: '3' }] });
    expect(await repository.count()).toBe(3);
  });

  it('findByCreditLineId parameterizes the lookup', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({ rows: [] });
    await repository.findByCreditLineId('cl-1', 5, 10);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('t.credit_line_id = $1'),
      ['cl-1', 10, 5],
    );
  });

  it('findByWalletAddress joins borrowers', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({ rows: [] });
    await repository.findByWalletAddress('GTEST');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('b.wallet_address = $1'),
      ['GTEST', 100, 0],
    );
  });

  it('updateStatus returns null when the row does not exist', async () => {
    expect(await repository.updateStatus('missing', TransactionStatus.CONFIRMED)).toBeNull();
  });

  it('updateStatus returns the in-process status when the row exists', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'tx-1',
        credit_line_id: 'cl-1',
        wallet_address: 'GTEST',
        amount: '10',
        type: TransactionType.REPAY,
        currency: 'USDC',
        created_at: new Date(),
      }],
    });

    const updated = await repository.updateStatus('tx-1', TransactionStatus.CONFIRMED);
    expect(updated?.status).toBe(TransactionStatus.CONFIRMED);
    expect(updated?.processedAt).toBeInstanceOf(Date);
  });

  it('findByStatus returns nothing for non-pending statuses', async () => {
    expect(await repository.findByStatus(TransactionStatus.FAILED)).toEqual([]);
  });

  it('findByStatus(PENDING) delegates to findAll', async () => {
    vi.mocked(client.query).mockResolvedValueOnce({ rows: [] });
    await repository.findByStatus(TransactionStatus.PENDING, 0, 5);
    expect(client.query).toHaveBeenCalled();
  });

  it('findAll maps joined rows', async () => {
    const now = new Date();
    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [{
        id: 'tx-1',
        credit_line_id: 'cl-1',
        wallet_address: 'GTEST',
        amount: '25',
        type: TransactionType.BORROW,
        currency: 'USDC',
        created_at: now,
      }],
    });
    const rows = await repository.findAll(0, 10);
    expect(rows[0]).toMatchObject({
      id: 'tx-1',
      walletAddress: 'GTEST',
      amount: '25',
      status: TransactionStatus.PENDING,
    });
  });
});
