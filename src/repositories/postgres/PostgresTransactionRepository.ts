import {
  TransactionStatus,
  type CreateTransactionRequest,
  type Transaction,
  type TransactionType,
} from '../../models/Transaction.js';
import type { TransactionRepository } from '../interfaces/TransactionRepository.js';
import type { DbClient } from '../../db/client.js';

interface TransactionRow {
  id: string;
  credit_line_id: string;
  wallet_address: string;
  amount: string;
  type: string;
  currency: string;
  created_at: Date;
}

/**
 * Postgres-backed ledger. Maps onto the `transactions` table from
 * `migrations/001_initial_schema.sql`. Status is not a persisted column in
 * the current schema; reads report {@link TransactionStatus.PENDING}.
 *
 * Must share the same {@link DbClient} as credit-line and audit writes so
 * draw/repay can commit (or roll back) all three together.
 */
export class PostgresTransactionRepository implements TransactionRepository {
  constructor(private client: DbClient) {}

  async create(request: CreateTransactionRequest): Promise<Transaction> {
    const query = `
      INSERT INTO transactions (credit_line_id, type, amount, currency)
      VALUES ($1, $2, $3, $4)
      RETURNING id, credit_line_id, type, amount, currency, created_at
    `;
    const result = await this.client.query(query, [
      request.creditLineId,
      request.type,
      request.amount,
      'USDC',
    ]);
    const row = result.rows[0] as Omit<TransactionRow, 'wallet_address'>;
    return {
      id: row.id,
      creditLineId: row.credit_line_id,
      walletAddress: '',
      amount: String(row.amount),
      type: row.type as TransactionType,
      status: TransactionStatus.PENDING,
      blockchainTxHash: request.blockchainTxHash,
      createdAt: row.created_at,
    };
  }

  async findById(id: string): Promise<Transaction | null> {
    const rows = await this.select('WHERE t.id = $1', [id]);
    return rows[0] ?? null;
  }

  async findByCreditLineId(creditLineId: string, offset = 0, limit = 100): Promise<Transaction[]> {
    return this.select(
      'WHERE t.credit_line_id = $1',
      [creditLineId, limit, offset],
      'ORDER BY t.created_at DESC LIMIT $2 OFFSET $3',
    );
  }

  async findByWalletAddress(walletAddress: string, offset = 0, limit = 100): Promise<Transaction[]> {
    return this.select(
      'WHERE b.wallet_address = $1',
      [walletAddress, limit, offset],
      'ORDER BY t.created_at DESC LIMIT $2 OFFSET $3',
    );
  }

  async updateStatus(id: string, status: TransactionStatus, processedAt?: Date): Promise<Transaction | null> {
    // Status is not a column on the current schema; return the row if present
    // so callers can still observe the requested transition in-process.
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }
    return {
      ...existing,
      status,
      processedAt: processedAt ?? new Date(),
    };
  }

  async findAll(offset = 0, limit = 100): Promise<Transaction[]> {
    return this.select('', [limit, offset], 'ORDER BY t.created_at DESC LIMIT $1 OFFSET $2');
  }

  async count(): Promise<number> {
    const result = await this.client.query('SELECT COUNT(*) as count FROM transactions');
    const row = result.rows[0] as { count: string };
    return parseInt(row.count, 10);
  }

  async findByStatus(_status: TransactionStatus, offset = 0, limit = 100): Promise<Transaction[]> {
    // No persisted status column — every row is treated as pending at rest.
    if (_status !== TransactionStatus.PENDING) {
      return [];
    }
    return this.findAll(offset, limit);
  }

  private async select(where: string, values: unknown[], tail = ''): Promise<Transaction[]> {
    const query = `
      SELECT t.id, t.credit_line_id, b.wallet_address, t.amount, t.type,
             t.currency, t.created_at
      FROM transactions t
      JOIN credit_lines cl ON t.credit_line_id = cl.id
      JOIN borrowers b ON cl.borrower_id = b.id
      ${where}
      ${tail}
    `;
    const result = await this.client.query(query, values);
    return (result.rows as TransactionRow[]).map((row) => this.toModel(row));
  }

  private toModel(row: TransactionRow): Transaction {
    return {
      id: row.id,
      creditLineId: row.credit_line_id,
      walletAddress: row.wallet_address,
      amount: String(row.amount),
      type: row.type as TransactionType,
      status: TransactionStatus.PENDING,
      createdAt: row.created_at,
    };
  }
}
