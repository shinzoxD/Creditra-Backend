/**
 * Append-only audit record for a credit-line mutation.
 *
 * Written in the same transaction as the balance update and ledger row so a
 * crash cannot leave a utilized figure without a matching audit payload
 * (or vice versa).
 */
export type CreditMutationAction = 'draw' | 'repay';

export const DRAW_CONFIRMED_EVENT = 'credit.draw_confirmed';
export const REPAY_CONFIRMED_EVENT = 'credit.repay_confirmed';

export interface CreditMutationAuditPayload {
  action: CreditMutationAction;
  walletAddress: string;
  /** Requested amount (always > 0). */
  amount: string;
  /** Amount actually applied to utilized (≤ amount; 0 when already paid off). */
  appliedAmount: string;
  utilizedBefore: string;
  utilizedAfter: string;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: CreditMutationAuditPayload;
  idempotencyKey?: string;
  createdAt: Date;
}

export interface AppendAuditEventRequest {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: CreditMutationAuditPayload;
  idempotencyKey?: string;
}

/**
 * Raised when an append hits a unique `idempotency_key`.
 * The service treats this as a successful replay: roll back the current
 * unit of work (if a sibling write raced) and return the already-committed line.
 */
export class DuplicateIdempotencyKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency key already used: ${key}`);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}
