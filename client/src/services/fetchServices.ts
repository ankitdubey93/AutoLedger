/**
 * The single place the client talks to the API. Every page goes through here so
 * the base URL, the `/api/v1` prefix, credential mode and error decoding are
 * defined once — the client-side mirror of the server's service layer.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const API_PREFIX = '/api/v1';

/** Thrown when the API answered, but with a non-2xx status. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — copy client/.env.example to client/.env');
  }

  const response = await fetch(`${API_BASE_URL}${API_PREFIX}${path}`, {
    // Required from Phase 1: the access and refresh tokens are httpOnly cookies,
    // and a cross-origin fetch omits cookies unless told otherwise.
    credentials: 'include',
    ...init,
    // Spread after `init` so a caller cannot accidentally drop Content-Type.
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });

  // A 502 from a proxy has no JSON body; don't let the parse failure mask the
  // real status code.
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed with status ${response.status}`;
    throw new ApiRequestError(response.status, message);
  }

  return body as T;
}

export interface HealthResponse {
  success: boolean;
  status: 'ok' | 'degraded';
  service: string;
  apiVersion: string;
  environment: string;
  uptimeSeconds: number;
  db: {
    connected: boolean;
    latencyMs: number | null;
    error?: string;
  };
}

/** GET /api/v1/health — the signal is required so callers cannot forget to cancel. */
export function getHealth(signal: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health', { signal });
}
