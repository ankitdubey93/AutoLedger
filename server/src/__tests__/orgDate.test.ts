import { describe, expect, it } from 'vitest';
import { isValidTimeZone, todayInZone } from '../utils/orgDate.js';

/**
 * Unit tier — no database. Pins the organization-local date arithmetic that
 * quote validity and expiry rest on.
 */

const NOON_UTC = new Date('2026-10-10T12:00:00Z');

describe('todayInZone', () => {
  it('returns the UTC date for UTC', () => {
    expect(todayInZone('UTC', NOON_UTC)).toBe('2026-10-10');
  });

  it('is the next day in UTC+14 (Pacific/Kiritimati)', () => {
    expect(todayInZone('Pacific/Kiritimati', NOON_UTC)).toBe('2026-10-11');
  });

  it('is the same day in UTC-11 (Pacific/Pago_Pago)', () => {
    expect(todayInZone('Pacific/Pago_Pago', NOON_UTC)).toBe('2026-10-10');
  });

  it('is the same day in America/Los_Angeles', () => {
    expect(todayInZone('America/Los_Angeles', NOON_UTC)).toBe('2026-10-10');
  });

  it('is the same day in Asia/Kolkata at noon UTC', () => {
    expect(todayInZone('Asia/Kolkata', NOON_UTC)).toBe('2026-10-10');
  });

  it('is the next day in Asia/Kolkata at 20:00 UTC', () => {
    expect(todayInZone('Asia/Kolkata', new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11');
  });

  it('falls back to the UTC date for an unknown zone', () => {
    expect(todayInZone('Not/AZone', NOON_UTC)).toBe('2026-10-10');
  });

  it('accepts a real IANA zone', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
  });

  it('rejects an unknown zone', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});
