import { env } from './env.js';

/**
 * Values referenced from more than one layer. Kept out of `routes/` and
 * `env.ts` so nothing has to import a router to learn the API version — that
 * would make routes and controllers circularly dependent.
 *
 * This file imports `env` but `env.ts` imports nothing from here, so the
 * dependency stays one-directional.
 */

/** URL path segment every route is mounted under. See docs/api.md. */
export const API_VERSION = 'v1';

export const API_BASE_PATH = `/api/${API_VERSION}`;

/** Rejecting oversized bodies before parsing is cheaper than after. */
export const JSON_BODY_LIMIT = '1mb';

/** Seconds to let in-flight requests finish before a forced exit. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ auth */

/**
 * `as const` is load-bearing. @types/jsonwebtoken types `SignOptions.expiresIn`
 * as `number | ms.StringValue`, a template-literal union — a value widened to
 * plain `string` fails to compile at the call site.
 */
export const ACCESS_TOKEN_TTL = '15m' as const;
export const REFRESH_TOKEN_TTL = '7d' as const;

/** The same 7 days in milliseconds, for the cookie maxAge and `expires_at`. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cookies are keyed by name + domain + path and **ignore the port**, so every
 * app on localhost shares one jar. A generic `access_token` would be clobbered
 * by any other project you run; the prefix makes collisions impossible.
 */
export const ACCESS_COOKIE_NAME = 'autoledger_at';
export const REFRESH_COOKIE_NAME = 'autoledger_rt';

/**
 * The refresh cookie is scoped to the auth routes, so it is not attached to
 * every ordinary API call and cannot leak through a proxy log or a request
 * dump. Anything clearing it must pass this exact path — see utils/cookies.ts.
 */
export const REFRESH_COOKIE_PATH = `${API_BASE_PATH}/auth`;

/**
 * bcrypt work factor. Cost 12 is ~250ms per hash, which is the point in
 * production and intolerable across a test suite that hashes on every fixture,
 * so tests drop to the minimum. Not an env var: a misconfigured production
 * value would be a silent security regression.
 */
export const BCRYPT_COST = env.isTest ? 4 : 12;

/**
 * bcrypt truncates at 72 **bytes** and ignores the rest, so two long passwords
 * sharing a 72-byte prefix hash identically. Reject rather than silently
 * accept a password that isn't fully checked.
 */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

/** Arbitrary but fixed: the key every migration runner locks on. */
export const MIGRATIONS_ADVISORY_LOCK_KEY = 4815162342;

// --------------------------------------------------------------- pagination

/**
 * List endpoints default to 20 rows and cap at 100 (docs/api.md).
 *
 * The cap is not politeness: without it a caller can ask for every journal
 * entry an organization has ever posted in one request, which is a slow query,
 * a large response, and an easy way to exhaust the connection pool.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// ------------------------------------------------------------ rate limiting

/**
 * Login and registration throttling — 10 attempts per 15 minutes per IP.
 *
 * Deferred from Phase 1 and paid here, as docs/development.md scheduled. Until
 * now, brute-forcing a password was unmitigated.
 *
 * The window is generous on purpose: this exists to make an automated
 * credential-stuffing run expensive, not to punish someone who mistypes their
 * password four times. It is per-IP, which is the honest limit of what a
 * stateless middleware can do — a distributed attacker with many IPs is
 * unaffected, and defending against that needs per-account tracking and a
 * shared store. Redis is available since Phase 7, but this limiter has not
 * been rewired to use it — that needs `rate-limit-redis`, which is not an
 * approved Phase 7 dependency (docs/development.md's dependency policy).
 */
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Tests hash and log in dozens of times against a single loopback IP, so a
 * production-sized limit would make the suite fail on its own fixtures. The
 * dedicated 429 test overrides this locally rather than relying on the ambient
 * value.
 */
export const AUTH_RATE_LIMIT_MAX = env.isTest ? 1000 : 10;

// ------------------------------------------------- bank reconciliation (6)

/**
 * A CSV statement arrives as a JSON string field, not a multipart upload —
 * file storage is Phase 10's problem, not this one. `JSON_BODY_LIMIT` is
 * '1mb'; this caps the CSV text itself well under that so JSON string
 * escaping (quotes, newlines) never pushes the whole request over the body
 * limit.
 */
export const MAX_CSV_CHARS = 900_000;

// ------------------------------------------------ background jobs (7)

/**
 * BullMQ retry policy. Five attempts with exponential backoff from 1s
 * (1s, 2s, 4s, 8s) spans ~15s of transient failure — long enough to ride
 * out a receiver's restart, short enough that a genuinely dead endpoint
 * reaches the dead-letter queue while the operator is still watching.
 *
 * Tests drop to two fast attempts: the suite must prove the dead-letter
 * path, and proving it at production timings would add ~15s per case.
 */
export const JOB_ATTEMPTS = env.isTest ? 2 : 5;
export const JOB_BACKOFF_MS = env.isTest ? 10 : 1_000;

/** Jobs kept in Redis after success, for `GET /health` to count. */
export const JOB_KEEP_COMPLETED = 100;

/** How often the outbox is drained into webhook deliveries. */
export const OUTBOX_DRAIN_INTERVAL_MS = 5_000;

/** Rows claimed per drain pass. Bounded so one pass cannot hold a long lock. */
export const OUTBOX_DRAIN_BATCH = 100;

/**
 * A PENDING delivery whose enqueue was lost (worker killed between COMMIT
 * and the Redis round trip) is re-enqueued by the next drain pass once it
 * is this stale. This is what makes delivery at-least-once rather than
 * at-most-once — see study/architecture/transactional-outbox.md.
 */
export const DELIVERY_REENQUEUE_AFTER_MS = 60_000;

/** Daily, at the top of the hour. Cron is UTC — the server's clock. */
export const INTEGRITY_CHECK_CRON = '0 3 * * *';

/**
 * A receiver gets 5 seconds. Longer holds a worker slot hostage to someone
 * else's slow endpoint; the retry policy covers a receiver that is merely
 * busy.
 */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/** Response body bytes retained in `webhook_deliveries.last_error`. */
export const WEBHOOK_ERROR_SNIPPET_CHARS = 500;

// ------------------------------------------------ document vault (9.5)

/**
 * Hard cap on one uploaded file, enforced by multer BEFORE the buffer is
 * fully read — `express.json`'s 1mb limit does not apply to multipart, so
 * without this a client could stream an arbitrarily large body into memory.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The multipart field name the upload route accepts. Exactly one file. */
export const UPLOAD_FIELD_NAME = 'file';

/**
 * Decided by magic bytes (utils/mimeSniff.ts), never by the client's
 * Content-Type header. A header is a claim; a signature is evidence.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/csv',
] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

// ------------------------------------------------------------- ap-flow (10)

/** Rasterization DPI. 200 is the floor at which tesseract reads a thermal receipt reliably. */
export const AP_FLOW_RASTER_DPI = 200;

/** Hard cap on pages per document — a 400-page PDF is a denial of service, not an invoice. */
export const AP_FLOW_MAX_PAGES = 20;

/** Outward padding on every mask box. OCR boxes are tight; an unpadded box leaves readable edges. */
export const AP_FLOW_REDACTION_PAD_PX = 3;

/** Where tesseract caches its language data. Never inside storage/, which is tenant data. */
export const TESSERACT_CACHE_DIR = '.tesseract';

/** The vision model AP-Flow extracts with. One place, so a change is one line. */
export const AP_FLOW_VISION_MODEL = 'claude-sonnet-5';

/** Ceiling on one extraction response. */
export const AP_FLOW_VISION_MAX_TOKENS = 4096;

/** A vision call that has not answered in 90s is not going to. */
export const AP_FLOW_VISION_TIMEOUT_MS = 90_000;

// ------------------------------------------------ ap-flow mapping (11)

/** Classification is a text call, not a vision call — the same model, far fewer tokens. */
export const AP_FLOW_CLASSIFY_MODEL = 'claude-sonnet-5';

/** Ceiling on one classification response — a short list of (line_index, account_code, confidence) triples. */
export const AP_FLOW_CLASSIFY_MAX_TOKENS = 2048;

/** Shorter than the vision timeout — no images in this call, so a slow answer is a service problem, not a large payload. */
export const AP_FLOW_CLASSIFY_TIMEOUT_MS = 30_000;

// ------------------------------------------------------------ taxguard (16)

/** Voyage AI's embedding model. One place, so a change is one line. */
export const TAXGUARD_EMBEDDING_MODEL = 'voyage-3.5';

/** Fixed at 1024 in migration 045's vector(1024) column — changing this is a new migration and a full re-embed. */
export const TAXGUARD_EMBEDDING_DIMENSIONS = 1024;

export const TAXGUARD_EMBEDDING_URL = 'https://api.voyageai.com/v1/embeddings';

/** An embedding call that has not answered in 60s is not going to. */
export const TAXGUARD_EMBEDDING_TIMEOUT_MS = 60_000;

/** Batch size per Voyage request during ingestion. */
export const TAXGUARD_EMBEDDING_BATCH_SIZE = 64;

/** Top-K chunks returned per retrieval. */
export const TAXGUARD_RETRIEVAL_TOP_K = 8;

/** Cosine-similarity floor below which a retrieved chunk is dropped as noise. */
export const TAXGUARD_RETRIEVAL_MIN_SCORE = 0.25;

/** The answer model TaxGuard cites with. Same model AP-Flow's classify step uses. */
export const TAXGUARD_ANSWER_MODEL = 'claude-sonnet-5';

/** Ceiling on one answer response. */
export const TAXGUARD_ANSWER_MAX_TOKENS = 2048;

/** An answer call that has not responded in 90s is not going to. */
export const TAXGUARD_ANSWER_TIMEOUT_MS = 90_000;
