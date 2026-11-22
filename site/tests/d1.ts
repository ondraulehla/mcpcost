import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * A D1 database in memory, over the SQLite of Node, with the site's own schema: prepare, bind, first, all, run and
 * batch, the part of the D1 API the board's queries use. It runs the same SQL as D1 does, so a test can hold
 * a query's answer byte for byte.
 */
class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.params as SQLInputValue[])) as T | undefined) ?? null;
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.params as SQLInputValue[]));
    return { success: true };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.params as SQLInputValue[])) as T[] };
  }
}

export interface MemoryD1 {
  /** The database the board's code reads, as env.DB. */
  d1: D1Database;
  /** The same database, for the test's own inserts. */
  sql: DatabaseSync;
}

export function memoryD1(): MemoryD1 {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const d1 = {
    prepare: (query: string) => new Statement(sql, query),
    // D1 runs a batch as one transaction; here the statements run one after the other on one connection.
    batch: async (statements: Statement[]) => Promise.all(statements.map((s) => s.all()))
  };
  return { d1: d1 as unknown as D1Database, sql };
}
