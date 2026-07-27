import Fastify, { type FastifyInstance } from 'fastify';

export interface ReadinessDependency { ready(): Promise<boolean> }
export function buildApp(options: { readonly logger?: boolean; readonly database?: ReadinessDependency } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? process.env['NODE_ENV'] !== 'test' });
  app.get('/health', async (_request, reply) => {
    const ready = options.database ? await options.database.ready() : true;
    if (!ready) reply.code(503);
    return { service: 'errandos-control-plane', status: ready ? 'ok' as const : 'unavailable' as const };
  });
  return app;
}