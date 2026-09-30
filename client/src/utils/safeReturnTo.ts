/** Returns value only when it is a safe URL to navigate to. Rejects protocol-relative, absolute external URLs, and backslashes. */
export function safeReturnTo(value: string | null): string | null {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  if (value.length > 200) return null;
  return value;
}
