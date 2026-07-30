import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/connect.js';
import { API_BASE_PATH, SHUTDOWN_TIMEOUT_MS } from './config/constants.js';

/**
 * Process entry point. Owns exactly two things the app itself must not:
 * the listening socket, and shutdown.
 */

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[server] ${env.NODE_ENV} — listening on http://localhost:${env.PORT}`);
  console.log(`[server] API base http://localhost:${env.PORT}${API_BASE_PATH}`);
  console.log(`[server] CORS origin ${env.FRONTEND_URL}`);
});

// Keep-alive sockets are why a naive shutdown appears to hang: an idle but open
// connection keeps the server "active". Bounding it here, and calling
// closeIdleConnections() below, is what makes draining finish promptly.
server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  // A second Ctrl-C must not restart the sequence mid-drain.
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[server] ${signal} received — draining`);

  // If a request hangs, exit anyway rather than sitting unkillable. unref() so
  // this timer is not itself a reason the loop stays alive.
  const forceExit = setTimeout(() => {
    console.error(`[server] drain exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // close() stops accepting new connections and fires once every existing one
    // has ended. Start listening for that first, then evict the idle keep-alive
    // sockets that would otherwise hold it open.
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeIdleConnections();
    await closed;

    // Only after HTTP is drained, so no in-flight request loses its connection.
    await closePool();

    console.log('[server] shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    console.error('[server] shutdown failed:', err);
    process.exit(1);
  }
}

// SIGTERM: `docker stop`, orchestrators. SIGINT: Ctrl-C in the terminal.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A process in an unknown state must not keep serving financial requests.
// Log, drain what we can, exit non-zero, let the supervisor restart us.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason);
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
  void shutdown('uncaughtException', 1);
});
