import { type Transaction, type CreateTransactionRequest, TransactionStatus } from '../../models/Transaction.js';
import type { TransactionRepository } from '../interfaces/TransactionRepository.js';
import { randomUUID } from 'crypto';

export class InMemoryTransactionRepository implements TransactionRepository {
  private transactions: Map<string, Transaction> = new Map();

  private sortByNewest(transactions: Transaction[]): Transaction[] {
    return transactions.sort((a, b) => {
      const tsDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (tsDiff !== 0) return tsDiff;
      return a.id.localeCompare(b.id);
    });
  }

  async create(request: CreateTransactionRequest): Promise<Transaction> {
    const id = randomUUID();
    const now = new Date();

    const transaction: Transaction = {
      id,
      creditLineId: request.creditLineId,
      walletAddress: '', // Will be set by service layer
      amount: request.amount,
      type: request.type,
      status: TransactionStatus.PENDING,
      blockchainTxHash: request.blockchainTxHash,
      createdAt: now
    };

    this.transactions.set(id, transaction);
    return transaction;
  }

  async findById(id: string): Promise<Transaction | null> {
    return this.transactions.get(id) || null;
  }

  async findByCreditLineId(creditLineId: string, offset = 0, limit = 100): Promise<Transaction[]> {
    const filtered = this.sortByNewest(
      Array.from(this.transactions.values()).filter(tx => tx.creditLineId === creditLineId)
    );

    return filtered.slice(offset, offset + limit);
  }

  async findByWalletAddress(walletAddress: string, offset = 0, limit = 100): Promise<Transaction[]> {
    const filtered = this.sortByNewest(
      Array.from(this.transactions.values()).filter(tx => tx.walletAddress === walletAddress)
    );

    return filtered.slice(offset, offset + limit);
  }

  async updateStatus(id: string, status: TransactionStatus, processedAt?: Date): Promise<Transaction | null> {
    const existing = this.transactions.get(id);
    if (!existing) {
      return null;
    }

    const updated: Transaction = {
      ...existing,
      status,
      processedAt: processedAt || new Date()
    };

    this.transactions.set(id, updated);
    return updated;
  }

  async findAll(offset = 0, limit = 100): Promise<Transaction[]> {
    const all = this.sortByNewest(Array.from(this.transactions.values()));
    
    return all.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.transactions.size;
  }

  async findByStatus(status: TransactionStatus, offset = 0, limit = 100): Promise<Transaction[]> {
    const filtered = this.sortByNewest(
      Array.from(this.transactions.values()).filter(tx => tx.status === status)
    );

    return filtered.slice(offset, offset + limit);
  }

  // Helper method for testing
  clear(): void {
    this.transactions.clear();
  }

  /** Test helper — snapshot for injected-failure rollback harnesses. */
  exportState(): Transaction[] {
    return Array.from(this.transactions.values()).map((tx) => ({ ...tx }));
  }

  /** Test helper — restore a snapshot taken by {@link exportState}. */
  importState(rows: Transaction[]): void {
    this.transactions.clear();
    for (const tx of rows) {
      this.transactions.set(tx.id, { ...tx });
    }
  }
}
