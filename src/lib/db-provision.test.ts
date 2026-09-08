import { describe, it, expect } from 'vitest';
import { assertSafeDatabaseName, withDatabaseName } from './db-provision';

describe('assertSafeDatabaseName', () => {
  it('accepts alphanumeric-and-underscore names', () => {
    expect(() => assertSafeDatabaseName('ethical_yoga_test_fix_517')).not.toThrow();
  });

  it('rejects a name with SQL-unsafe characters', () => {
    expect(() => assertSafeDatabaseName('ethical_yoga"; DROP TABLE x; --')).toThrow();
  });
});

describe('withDatabaseName', () => {
  it('replaces only the path of the connection URL', () => {
    const result = withDatabaseName('postgresql://yoga:pw@localhost:5432/ethical_yoga', 'postgres');
    expect(result).toBe('postgresql://yoga:pw@localhost:5432/postgres');
  });
});
