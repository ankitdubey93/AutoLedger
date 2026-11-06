import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { abnDigits, formatAbn, isValidAbn } from '../../utils/abn.js';

/**
 * Phase 49f — optional verification against the ABR's ABN Lookup web service.
 * Off unless ABR_GUID is set. The ABN is the only thing sent, and it is public
 * data. Plain `fetch`, no SDK; the fetch is injectable so no test reaches the network.
 */
export interface AbnLookupResult {
  abn: string;
  active: boolean;
  entityName: string;
  gstRegisteredFrom: string | null;
}

const LOOKUP_TIMEOUT_MS = 5000;
const ENDPOINT = 'https://abr.business.gov.au/json/AbnDetails.aspx';

export function abnLookupEnabled(): boolean {
  return env.ABR_GUID !== '';
}

function parseJsonp(body: string): Record<string, unknown> {
  const start = body.indexOf('(');
  const end = body.lastIndexOf(')');
  if (start === -1 || end === -1) throw new ApiError(502, 'ABN Lookup returned something unexpected');
  const parsed: unknown = JSON.parse(body.slice(start + 1, end));
  if (typeof parsed !== 'object' || parsed === null) throw new ApiError(502, 'ABN Lookup returned something unexpected');
  return parsed as Record<string, unknown>;
}

export async function lookupAbn(raw: string, fetchImpl: typeof fetch = fetch): Promise<AbnLookupResult | null> {
  if (!abnLookupEnabled()) throw new ApiError(503, 'ABN Lookup is not configured');
  if (!isValidAbn(raw)) throw new ApiError(422, 'That is not a valid ABN');
  const url = `${ENDPOINT}?abn=${abnDigits(raw)}&callback=callback&guid=${encodeURIComponent(env.ABR_GUID)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch {
    throw new ApiError(502, 'ABN Lookup could not be reached');
  }
  if (!response.ok) throw new ApiError(502, 'ABN Lookup could not be reached');
  const data = parseJsonp(await response.text());
  // The service answers 200 with an empty Abn for a number it does not know.
  if (typeof data.Abn !== 'string' || data.Abn === '') return null;
  return {
    abn: formatAbn(data.Abn),
    active: data.AbnStatus === 'Active',
    entityName: typeof data.EntityName === 'string' ? data.EntityName : '',
    gstRegisteredFrom: typeof data.Gst === 'string' && data.Gst !== '' ? data.Gst : null,
  };
}
