import { ApiError } from './apiError.js';
import { env } from '../config/env.js';

/**
 * A webhook URL is attacker-controlled input that the SERVER will later
 * fetch. Without this guard, `http://169.254.169.254/latest/meta-data/` or
 * `http://localhost:5432` turns the webhook feature into a port scanner and
 * a cloud-credential exfiltration path from inside the trust boundary
 * (SSRF). Validate at write time, and never follow a redirect at send time
 * — a 302 to a private address would bypass everything checked here.
 *
 * Known limit: this is a write-time check, so a hostname that resolves
 * publicly today and to 127.0.0.1 tomorrow (DNS rebinding) still gets
 * fetched. Closing that needs resolve-then-connect-to-the-resolved-IP,
 * which Node's fetch does not expose. Recorded, not fixed.
 */
export function assertDeliverableUrl(raw: string): string {
  if (raw.length > 500) {
    throw new ApiError(400, 'Webhook URL must be 500 characters or fewer');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'Webhook URL must be a valid absolute URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiError(400, 'Webhook URL must use https');
  }

  // Plain http stays legal outside production so a developer can point at a
  // local receiver.
  if (url.protocol === 'http:' && env.isProduction) {
    throw new ApiError(400, 'Webhook URL must use https');
  }

  if (url.username !== '' || url.password !== '') {
    throw new ApiError(400, 'Webhook URL must not contain credentials');
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new ApiError(400, 'Webhook URL must not target a private host');
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match !== null) {
    const first = Number(ipv4Match[1]);
    const second = Number(ipv4Match[2]);
    const isPrivate =
      first === 10 ||
      first === 127 ||
      first === 0 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254);
    if (isPrivate) {
      throw new ApiError(400, 'Webhook URL must not target a private host');
    }
  }

  // IPv6 literals are rejected wholesale: enumerating their private ranges
  // correctly is more code than the feature justifies, and a hostname is the
  // normal case.
  if (hostname.startsWith('[')) {
    throw new ApiError(400, 'Webhook URL must not target a private host');
  }

  return url.toString();
}
