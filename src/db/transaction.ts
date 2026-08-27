import type { DbClient } from './client.js';

/**
 * Run `work` inside a PostgreSQL transaction on `client`.
 *
 * Lifecycle:
 * 1. `BEGIN`
 * 2. await `work()`
 * 3. `COMMIT` on success, or `ROLLBACK` on any thrown error (re-thrown)
 *
 * When `client` is `undefined` (in-memory / test wiring without Postgres),
 * `work` runs without BEGIN/COMMIT — there is no multi-connection ledger to
 * keep consistent. Callers that need true atomicity must supply a real
 * {@link DbClient}.
 *
 * Nested usage on the same connection is **not** supported (plain BEGIN, no
 * SAVEPOINT). Service methods that already call `withTransaction` must not
 * nest another transaction on the same client.
 *
 * Keep `work` short: no HTTP, Soroban RPC, or webhook I/O inside the boundary.
 */
export async function withTransaction<T>(
  client: DbClient | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!client) {
    return work();
  }

  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Prefer the original failure over a secondary rollback error.
    }
    throw error;
  }
}

/**
 * Injectable transaction boundary used by domain services.
 *
 * Production wires {@link createDbTransactionRunner}; tests inject a no-op
 * or a failure-injecting runner without needing a live Postgres connection.
 */
export type TransactionRunner = <T>(work: () => Promise<T>) => Promise<T>;

/** No-op runner: executes work immediately (in-memory repositories / unit tests). */
export const passthroughTransactionRunner: TransactionRunner = async (work) => work();

/** Build a runner that wraps work in `BEGIN`/`COMMIT`/`ROLLBACK` on `client`. */
export function createDbTransactionRunner(client: DbClient): TransactionRunner {
  return <T>(work: () => Promise<T>) => withTransaction(client, work);
}
