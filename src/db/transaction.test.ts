import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from './client.js';
import {
  withTransaction,
  createDbTransactionRunner,
  passthroughTransactionRunner,
} from './transaction.js';

function createRecordingClient(options?: {
  /** Fail when this SQL fragment is seen (case-insensitive). */
  failOn?: string | RegExp;
  /** Fail on the Nth non-control query (1-based). Control = BEGIN/COMMIT/ROLLBACK. */
  failOnDataQuery?: number;
}): DbClient & { statements: string[] } {
  const statements: string[] = [];
  let dataQueryCount = 0;

  const client: DbClient & { statements: string[] } = {
    statements,
    async query(text: string) {
      statements.push(text);
      const normalized = text.trim().toUpperCase();
      const isControl =
        normalized === 'BEGIN' ||
        normalized === 'COMMIT' ||
        normalized === 'ROLLBACK';

      if (!isControl) {
        dataQueryCount += 1;
        if (
          options?.failOnDataQuery !== undefined &&
          dataQueryCount === options.failOnDataQuery
        ) {
          throw new Error(`injected failure on data query #${dataQueryCount}`);
        }
      }

      if (options?.failOn) {
        const pattern =
          typeof options.failOn === 'string'
            ? new RegExp(options.failOn, 'i')
            : options.failOn;
        if (pattern.test(text)) {
          throw new Error(`injected failure on: ${text}`);
        }
      }

      return { rows: [] };
    },
    async end() {
      /* no-op */
    },
  };

  return client;
}

describe('withTransaction', () => {
  it('runs work without control statements when client is undefined', async () => {
    const result = await withTransaction(undefined, async () => 42);
    expect(result).toBe(42);
  });

  it('commits after successful work', async () => {
    const client = createRecordingClient();
    const result = await withTransaction(client, async () => {
      await client.query('INSERT INTO t VALUES (1)');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(client.statements).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ]);
  });

  it('rolls back and rethrows when work fails', async () => {
    const client = createRecordingClient();

    await expect(
      withTransaction(client, async () => {
        await client.query('INSERT INTO t VALUES (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(client.statements).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
    expect(client.statements).not.toContain('COMMIT');
  });

  it('rolls back when a mid-flow data query fails (failure injection)', async () => {
    const client = createRecordingClient({ failOnDataQuery: 2 });

    await expect(
      withTransaction(client, async () => {
        await client.query('UPDATE credit_lines SET utilized = $1');
        await client.query('INSERT INTO transactions ...');
        return 'unreachable';
      }),
    ).rejects.toThrow('injected failure on data query #2');

    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(client.statements).not.toContain('COMMIT');
  });

  it('prefers the original error if ROLLBACK itself fails', async () => {
    const statements: string[] = [];
    const client: DbClient = {
      async query(text: string) {
        statements.push(text);
        const n = text.trim().toUpperCase();
        if (n === 'ROLLBACK') {
          throw new Error('rollback failed');
        }
        return { rows: [] };
      },
      async end() {
        /* no-op */
      },
    };

    await expect(
      withTransaction(client, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

describe('createDbTransactionRunner', () => {
  it('delegates to withTransaction on the given client', async () => {
    const client = createRecordingClient();
    const run = createDbTransactionRunner(client);
    const value = await run(async () => {
      await client.query('SELECT 1');
      return 7;
    });
    expect(value).toBe(7);
    expect(client.statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });
});

describe('passthroughTransactionRunner', () => {
  it('executes work without a database client', async () => {
    const spy = vi.fn(async () => 'done');
    await expect(passthroughTransactionRunner(spy)).resolves.toBe('done');
    expect(spy).toHaveBeenCalledOnce();
  });
});
