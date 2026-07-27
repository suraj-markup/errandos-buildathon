import { openProductionDatabase, type PostgresDatabase } from '@errandos/persistence';
import { buildApp } from './app.js';
import { validateDeploymentEnvironment } from './deployment.js';

export function parsePort(value: string | undefined): number {
  const port = value === undefined ? 3001 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid PORT: ${value ?? ''}`);
  return port;
}

let database: PostgresDatabase | undefined;
const mode = process.env['ERRANDOS_PERSISTENCE_MODE'];
validateDeploymentEnvironment(process.env);
if (mode !== 'filesystem') database = await openProductionDatabase();
const app = buildApp(database ? { database } : {});
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database?.close();
};
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host: '0.0.0.0', port: parsePort(process.env['PORT']) });
} catch (error: unknown) {
  app.log.error(error, 'control-plane startup failed');
  await app.close();
  await database?.close();
  process.exitCode = 1;
}
