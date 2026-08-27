import { type CreditLine, type CreateCreditLineRequest, type UpdateCreditLineRequest, CreditLineStatus } from '../models/CreditLine.js';
import type { CreditLineRepository, CursorPaginationResult } from '../repositories/interfaces/CreditLineRepository.js';
import type { TransactionRepository } from '../repositories/interfaces/TransactionRepository.js';
import type { AuditEventRepository } from '../repositories/interfaces/AuditEventRepository.js';
import { TransactionType } from '../models/Transaction.js';
import {
  DRAW_CONFIRMED_EVENT,
  DuplicateIdempotencyKeyError,
  REPAY_CONFIRMED_EVENT,
  type CreditMutationAction,
} from '../models/AuditEvent.js';
import {
  passthroughTransactionRunner,
  type TransactionRunner,
} from '../db/transaction.js';

/**
 * Optional dependencies that enable atomic multi-write credit mutations.
 *
 * - `transactionRepository` — ledger writes paired with draw/repay
 * - `auditEventRepository` — audit events paired with the committed balance
 * - `runInTransaction` — BEGIN/COMMIT/ROLLBACK boundary (Postgres) or
 *   passthrough (in-memory). Tests inject a snapshot runner to prove rollback.
 */
export interface CreditLineServiceDeps {
  transactionRepository?: TransactionRepository;
  auditEventRepository?: AuditEventRepository;
  runInTransaction?: TransactionRunner;
}

/** Extra options for draw / repay (idempotent retries). */
export interface DrawRepayOptions {
  /**
   * When set, a second call with the same key is a no-op that returns the
   * already-committed credit line. Stored on the audit row (unique).
   */
  idempotencyKey?: string;
}

/**
 * Domain service for credit-line CRUD plus the `draw` / `repay` operations.
 *
 * Depends on the {@link CreditLineRepository} interface, not on a concrete
 * Postgres or in-memory implementation — the {@link Container} picks the
 * implementation at boot based on `DATABASE_URL` + `NODE_ENV`.
 *
 * Invariants enforced here, *before* the repository call:
 * - `walletAddress` is required on create
 * - `creditLimit` must parse to a positive decimal
 * - `interestRateBps` is clamped to the basis-points range `0..10000`
 * - Pagination `limit` is clamped to `1..100`; `offset` must be `≥ 0`
 *
 * **Transaction boundaries.** `draw` and `repay` write credit-line state,
 * a ledger row, and an audit event inside one {@link TransactionRunner} so a
 * mid-flow failure rolls back every write. The line is locked (`lockById` /
 * `SELECT … FOR UPDATE`) and serialized per id so concurrent calls cannot
 * lose updates or drive utilized negative.
 *
 * Errors are thrown as plain {@link Error} with human-readable messages so
 * the route layer can map them to the `{ data, error }` response envelope.
 *
 * See `docs/ARCHITECTURE.md` §2 (request lifecycle) and `docs/API.md` for
 * the surfaces that call into this service.
 */
export class CreditLineService {
  private readonly transactionRepository?: TransactionRepository;
  private readonly auditEventRepository?: AuditEventRepository;
  private readonly runInTransaction: TransactionRunner;
  private readonly lineLocks = new Map<string, Promise<unknown>>();

  constructor(
    private creditLineRepository: CreditLineRepository,
    deps: CreditLineServiceDeps = {},
  ) {
    this.transactionRepository = deps.transactionRepository;
    this.auditEventRepository = deps.auditEventRepository;
    this.runInTransaction = deps.runInTransaction ?? passthroughTransactionRunner;
  }

  /**
   * Create a new credit line for `walletAddress` with an explicit credit limit
   * and (optional) interest rate.
   *
   * @throws if `walletAddress` is empty, `creditLimit` ≤ 0, or
   * `interestRateBps` is outside `0..10000`.
   */
  async createCreditLine(request: CreateCreditLineRequest): Promise<CreditLine> {
    // Validate request
    if (!request.walletAddress) {
      throw new Error('Wallet address is required');
    }
    
    if (!request.creditLimit || parseFloat(request.creditLimit) <= 0) {
      throw new Error('Credit limit must be greater than 0');
    }

    if (request.interestRateBps < 0 || request.interestRateBps > 10000) {
      throw new Error('Interest rate must be between 0 and 10000 basis points');
    }

    return await this.creditLineRepository.create(request);
  }

  /** Fetch a single credit line by id, or `null` if not found. */
  async getCreditLine(id: string): Promise<CreditLine | null> {
    return await this.creditLineRepository.findById(id);
  }

  /** List every credit line owned by `walletAddress` (may be empty). */
  async getCreditLinesByWallet(walletAddress: string): Promise<CreditLine[]> {
    return await this.creditLineRepository.findByWalletAddress(walletAddress);
  }

  /**
   * Offset-pagination list of credit lines.
   *
   * @param offset zero-based row offset, must be `≥ 0`
   * @param limit page size, clamped to `1..100`
   */
  async getAllCreditLines(offset?: number, limit?: number): Promise<CreditLine[]> {
    if (offset !== undefined && offset < 0) {
      throw new Error('Offset cannot be negative');
    }
    if (limit !== undefined && limit <= 0) {
      throw new Error('Limit must be greater than 0');
    }
    if (limit !== undefined && limit > 100) {
      throw new Error('Limit cannot exceed 100');
    }
    return await this.creditLineRepository.findAll(offset, limit);
  }

  /**
   * Cursor-pagination list — preferred for large datasets because the cursor
   * is stable against concurrent inserts. The cursor is an opaque string
   * minted by the repository; clients pass `nextCursor` back unchanged.
   *
   * @see `docs/cursor-pagination.md`
   */
  async getAllCreditLinesWithCursor(cursor?: string, limit?: number): Promise<CursorPaginationResult> {
    if (limit !== undefined && limit <= 0) {
      throw new Error('Limit must be greater than 0');
    }
    if (limit !== undefined && limit > 100) {
      throw new Error('Limit cannot exceed 100');
    }
    return await this.creditLineRepository.findAllWithCursor(cursor, limit);
  }

  /**
   * Patch credit-line fields (`creditLimit`, `interestRateBps`, `status`).
   *
   * Validates limit/rate bounds before delegating to the repository. Returns
   * `null` if `id` does not exist — the route layer maps that to `404`.
   */
  async updateCreditLine(id: string, request: UpdateCreditLineRequest): Promise<CreditLine | null> {
    // Validate update request
    if (request.creditLimit && parseFloat(request.creditLimit) <= 0) {
      throw new Error('Credit limit must be greater than 0');
    }

    if (request.interestRateBps !== undefined && 
        (request.interestRateBps < 0 || request.interestRateBps > 10000)) {
      throw new Error('Interest rate must be between 0 and 10000 basis points');
    }

    return await this.creditLineRepository.update(id, request);
  }

  /** Hard-delete a credit line. Returns `false` if `id` did not exist. */
  async deleteCreditLine(id: string): Promise<boolean> {
    return await this.creditLineRepository.delete(id);
  }

  /** Total credit-line row count — used for paging headers. */
  async getCreditLineCount(): Promise<number> {
    return await this.creditLineRepository.count();
  }

  /**
   * Deduct `amount` from the line's available credit.
   *
   * Enforced rules:
   * - line must exist (otherwise throws "Credit line not found")
   * - `borrowerId` (wallet address) must match `line.walletAddress` (otherwise throws "Unauthorized")
   * - line `status` must be {@link CreditLineStatus.ACTIVE}
   * - `utilized + amount` must not exceed `creditLimit`
   *
   * **Atomicity.** Balance update, ledger row (`borrow`), and audit event
   * commit together. If any write fails, all three roll back.
   *
   * The on-chain transaction is submitted separately via `SorobanRpcClient`
   * — confirmation flows back through the indexer.
   */
  async draw(
    id: string,
    borrowerId: string,
    amount: string,
    options: DrawRepayOptions = {},
  ): Promise<CreditLine> {
    const amountNum = parsePositiveAmount(amount, 'Draw amount');
    return this.withLineLock(id, () =>
      this.commitMutation({
        id,
        action: 'draw',
        amount,
        amountNum,
        actorWallet: borrowerId,
        requireOwner: true,
        requireActive: true,
        idempotencyKey: options.idempotencyKey,
      }),
    );
  }

  /**
   * Restore `amount` of available credit by reducing the line's `utilized`
   * balance. The utilized amount is floored at `0` so a stray overpayment
   * can never produce negative utilization on the persisted row.
   *
   * Repeated and concurrent repayments are serialized per credit line and
   * re-read inside the transaction, so the final utilized is deterministic:
   * `max(0, start − Σ applied)`. An optional {@link DrawRepayOptions.idempotencyKey}
   * makes a retried request a no-op.
   *
   * **Atomicity.** Balance update, ledger row (`repay`), and audit event
   * commit in one transaction — same guarantees as {@link draw}.
   */
  async repay(
    id: string,
    walletAddress: string,
    amount: string,
    options: DrawRepayOptions = {},
  ): Promise<CreditLine> {
    const amountNum = parsePositiveAmount(amount, 'Repay amount');
    return this.withLineLock(id, () =>
      this.commitMutation({
        id,
        action: 'repay',
        amount,
        amountNum,
        actorWallet: walletAddress,
        requireOwner: true,
        requireActive: false,
        idempotencyKey: options.idempotencyKey,
      }),
    );
  }

  /**
   * Serialize mutations per credit-line id so concurrent in-process calls
   * cannot both read the same utilized and both commit. Postgres deployments
   * additionally take `SELECT … FOR UPDATE` inside the transaction.
   */
  private async withLineLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lineLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lineLocks.set(
      id,
      previous.then(() => gate, () => gate),
    );
    await previous.then(() => undefined, () => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async loadLine(id: string): Promise<CreditLine | null> {
    if (this.creditLineRepository.lockById) {
      return this.creditLineRepository.lockById(id);
    }
    return this.creditLineRepository.findById(id);
  }

  private async commitMutation(input: {
    id: string;
    action: CreditMutationAction;
    amount: string;
    amountNum: number;
    actorWallet: string;
    requireOwner: boolean;
    requireActive: boolean;
    idempotencyKey?: string;
  }): Promise<CreditLine> {
    try {
      return await this.runInTransaction(async () => {
        if (input.idempotencyKey && this.auditEventRepository) {
          const existing = await this.auditEventRepository.findByIdempotencyKey(input.idempotencyKey);
          if (existing) {
            const current = await this.creditLineRepository.findById(input.id);
            if (!current) {
              throw new Error('Credit line not found');
            }
            return current;
          }
        }

        const line = await this.loadLine(input.id);
        if (!line) {
          throw new Error('Credit line not found');
        }

        if (input.requireOwner && line.walletAddress !== input.actorWallet) {
          throw new Error('Unauthorized');
        }

        if (input.requireActive && line.status !== CreditLineStatus.ACTIVE) {
          throw new Error('Credit line is not active');
        }

        const limitNum = parseFloat(line.creditLimit);
        const parsedUtilized = parseFloat(line.utilized || '0');
        const utilizedBeforeNum = Number.isFinite(parsedUtilized) ? parsedUtilized : 0;
        const utilizedBefore = formatAmount(utilizedBeforeNum);

        let appliedNum: number;
        let utilizedAfterNum: number;

        if (input.action === 'draw') {
          if (utilizedBeforeNum + input.amountNum > limitNum) {
            throw new Error('Credit limit exceeded');
          }
          appliedNum = input.amountNum;
          utilizedAfterNum = utilizedBeforeNum + input.amountNum;
        } else {
          appliedNum = Math.min(input.amountNum, Math.max(0, utilizedBeforeNum));
          utilizedAfterNum = utilizedBeforeNum - appliedNum;
        }

        const utilizedAfter = formatAmount(utilizedAfterNum);
        const appliedAmount = formatAmount(appliedNum);

        const updated = await this.creditLineRepository.update(input.id, {
          utilized: utilizedAfter,
        });
        if (!updated) {
          throw new Error('Credit line not found');
        }

        if (this.transactionRepository) {
          await this.transactionRepository.create({
            creditLineId: input.id,
            amount: input.amount,
            type: input.action === 'draw' ? TransactionType.BORROW : TransactionType.REPAY,
          });
        }

        if (this.auditEventRepository) {
          await this.auditEventRepository.append({
            eventType: input.action === 'draw' ? DRAW_CONFIRMED_EVENT : REPAY_CONFIRMED_EVENT,
            aggregateType: 'credit_line',
            aggregateId: input.id,
            payload: {
              action: input.action,
              walletAddress: line.walletAddress,
              amount: input.amount,
              appliedAmount,
              utilizedBefore,
              utilizedAfter: updated.utilized,
            },
            idempotencyKey: input.idempotencyKey,
          });
        }

        return updated;
      });
    } catch (error) {
      if (error instanceof DuplicateIdempotencyKeyError) {
        const current = await this.creditLineRepository.findById(input.id);
        if (!current) {
          throw new Error('Credit line not found');
        }
        return current;
      }
      throw error;
    }
  }
}

function parsePositiveAmount(amount: string, label: string): number {
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return amountNum;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value === 0 || Object.is(value, -0)) {
    return '0';
  }
  return String(value);
}
