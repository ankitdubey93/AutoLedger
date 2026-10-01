/**
 * "Chrome on Windows" from a User-Agent string, for the sessions list.
 * Deliberately coarse: it names the browser and platform a person would
 * recognise, and falls back to "Unknown device". Order matters — Edge and
 * Opera include "Chrome", and Chrome includes "Safari".
 */
export function describeUserAgent(ua: string | null): string {
  if (ua === null || ua.trim() === '') return 'Unknown device';

  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;

  const platform = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;

  if (browser === null && platform === null) return ua.slice(0, 60);
  if (browser === null) return platform ?? 'Unknown device';
  return platform === null ? browser : `${browser} on ${platform}`;
}
