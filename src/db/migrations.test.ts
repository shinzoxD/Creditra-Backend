import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from './client.js';
import {
  ensureSchemaMigrations,
  listMigrationFiles,
  versionFromFilename,
  getAppliedVersions,
  applyMigration,
  runPendingMigrations,
  EXPECTED_TABLES,
} from './migrations.js';

function createMockClient(overrides: Partial<DbClient> = {}): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('versionFromFilename', () => {
  it('strips .sql extension', () => {
    expect(versionFromFilename('001_initial_schema.sql')).toBe('001_initial_schema');
  });

  it('returns full name if no .sql', () => {
    expect(versionFromFilename('001_initial_schema')).toBe('001_initial_schema');
  });
});

describe('ensureSchemaMigrations', () => {
  it('runs CREATE TABLE IF NOT EXISTS for schema_migrations', async () => {
    const client = createMockClient();
    await ensureSchemaMigrations(client);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations')
    );
  });
});

describe('getAppliedVersions', () => {
  it('ensures schema_migrations then returns version list', async () => {
    const client = createMockClient();
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ version: '001_initial_schema' }],
      });
    const versions = await getAppliedVersions(client);
    expect(versions).toEqual(['001_initial_schema']);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no migrations applied', async () => {
    const client = createMockClient();
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const versions = await getAppliedVersions(client);
    expect(versions).toEqual([]);
  });
});

describe('listMigrationFiles', () => {
  it('returns sorted .sql files from directory', async () => {
    const { join } = await import('path');
    const dir = join(process.cwd(), 'migrations');
    const files = await listMigrationFiles(dir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain('001_initial_schema.sql');
    expect(files.every((f) => f.endsWith('.sql'))).toBe(true);
    expect(files).toEqual([...files].sort());
  });
});

describe('applyMigration', () => {
  it('reads file, runs SQL, then records version', async () => {
    const client = createMockClient();
    const migrationsDir = await import('path').then((p) =>
      p.join(process.cwd(), 'migrations')
    );
    await applyMigration(client, migrationsDir, '001_initial_schema.sql');
    expect(client.query).toHaveBeenCalled();
    const insertCall = vi.mocked(client.query).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO schema_migrations')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual(['001_initial_schema']);
  });
});

describe('runPendingMigrations', () => {
  it('skips already applied migrations', async () => {
    const client = createMockClient();
    const migrationsDir = await import('path').then((p) =>
      p.join(process.cwd(), 'migrations')
    );
    const files = await listMigrationFiles(migrationsDir);
    const applied = files.map((f) => versionFromFilename(f)).map((version) => ({ version }));
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: applied });
    const run = await runPendingMigrations(client, migrationsDir);
    expect(run).toEqual([]);
  });

  it('applies pending migration and returns its version', async () => {
    const client = createMockClient();
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const migrationsDir = await import('path').then((p) =>
      p.join(process.cwd(), 'migrations')
    );
    const run = await runPendingMigrations(client, migrationsDir);
    expect(run).toContain('001_initial_schema');
    expect(run).toContain('002_add_interest_rate_to_credit_lines');
    expect(run).toContain('003_add_utilized_to_credit_lines');
    expect(run.length).toBeGreaterThanOrEqual(3);
  });

  it('applies only new migrations when some are already applied', async () => {
    const client = createMockClient();
    vi.mocked(client.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version: '001_initial_schema' }] });
    const migrationsDir = await import('path').then((p) =>
      p.join(process.cwd(), 'migrations')
    );
    const run = await runPendingMigrations(client, migrationsDir);
    expect(run).toContain('002_add_interest_rate_to_credit_lines');
    expect(run).not.toContain('001_initial_schema');
  });
});

describe('EXPECTED_TABLES', () => {
  it('includes all core domain tables', () => {
    expect(EXPECTED_TABLES).toEqual([
      'borrowers',
      'credit_lines',
      'risk_evaluations',
      'transactions',
      'events',
    ]);
  });
});
