import { readFile } from 'node:fs/promises';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';

export type Database = Pick<Pool, 'query'>;

export class PostgresDatabase {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }
  async ready(): Promise<boolean> { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  async close(): Promise<void> { await this.pool.end(); }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async migrate(path: string): Promise<void> { await this.pool.query(await readFile(path, 'utf8')); }
}

/** Production selection is deliberately strict; local adapters must be chosen explicitly by callers. */
export async function openProductionDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<PostgresDatabase> {
  const connectionString = environment['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL production persistence');
  const database = new PostgresDatabase(connectionString);
  if (!await database.ready()) { await database.close(); throw new Error('PostgreSQL is unavailable; readiness failed'); }
  return database;
}

export async function oneOrUndefined<T extends QueryResultRow>(result: QueryResult<T>): Promise<T | undefined> {
  return result.rows[0];
}
