import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * Every Redis connection this process opens (BullMQ queues, workers, and the
 * health-check ping) is tracked here so `closeRedisConnections` can quit
 * every one on shutdown — mirroring `db/connect.ts`'s single `pool` plus
 * `closePool`.
 */
const connections: Redis[] = [];

/**
 * `maxRetriesPerRequest: null` is mandatory. BullMQ issues blocking commands
 * (BRPOPLPUSH and friends) that legitimately wait far longer than ioredis's
 * default retry budget (20 attempts) allows — with the default, a worker
 * sitting on an idle queue throws `MaxRetriesPerRequestError` instead of
 * just... waiting. `enableReadyCheck: false` is BullMQ's own documented
 * companion setting for the same reason.
 */
export function createRedisConnection(): Redis {
  const connection = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    db: env.REDIS_DB,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connections.push(connection);
  return connection;
}

export interface RedisPing {
  connected: boolean;
  latencyMs: number | null;
  error?: string;
}

let pingConnection: Redis | undefined;

/**
 * Mirrors `healthService.checkDatabase` exactly: a real round trip, never
 * throws, reports failure as data instead of an exception.
 */
export async function pingRedis(): Promise<RedisPing> {
  pingConnection ??= createRedisConnection();
  const startedAt = performance.now();
  try {
    await pingConnection.ping();
    return { connected: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return {
      connected: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : 'Unknown Redis error',
    };
  }
}

export async function closeRedisConnections(): Promise<void> {
  await Promise.all(
    connections.map((connection) => connection.quit().catch(() => undefined)),
  );
  connections.length = 0;
  pingConnection = undefined;
}
