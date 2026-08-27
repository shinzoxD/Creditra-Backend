import type { CreditLine, CreateCreditLineRequest, UpdateCreditLineRequest } from '../../models/CreditLine.js';

export interface CursorPaginationResult {
  items: CreditLine[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CreditLineRepository {
  /**
   * Create a new credit line
   */
  create(request: CreateCreditLineRequest): Promise<CreditLine>;

  /**
   * Find credit line by ID
   */
  findById(id: string): Promise<CreditLine | null>;

  /**
   * Lock the row for the remainder of the current transaction (Postgres
   * `SELECT … FOR UPDATE`). In-memory implementations alias {@link findById}.
   * Optional so existing test doubles keep compiling.
   */
  lockById?(id: string): Promise<CreditLine | null>;

  /**
   * Find credit lines by wallet address
   */
  findByWalletAddress(walletAddress: string): Promise<CreditLine[]>;

  /**
   * Get all credit lines with optional pagination
   */
  findAll(offset?: number, limit?: number): Promise<CreditLine[]>;

  /**
   * Get all credit lines with cursor-based pagination
   */
  findAllWithCursor(cursor?: string, limit?: number): Promise<CursorPaginationResult>;

  /**
   * Update credit line
   */
  update(id: string, request: UpdateCreditLineRequest): Promise<CreditLine | null>;

  /**
   * Delete credit line
   */
  delete(id: string): Promise<boolean>;

  /**
   * Check if credit line exists
   */
  exists(id: string): Promise<boolean>;

  /**
   * Get total count of credit lines
   */
  count(): Promise<number>;
}