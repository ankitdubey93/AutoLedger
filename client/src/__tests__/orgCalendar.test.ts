import { afterEach, describe, expect, it } from 'vitest';
import { configureOrgCalendar, formatDate, orgNow, orgToday } from '../utils/date';
import { visibleNavGroups } from '../components/layout/nav';

afterEach(() => configureOrgCalendar('GENERIC', 'UTC'));

// 00:30 on 1 July in Sydney (UTC+10) is still 30 June in UTC.
const FIRST_OF_QUARTER_IN_SYDNEY = new Date('2026-06-30T14:30:00Z');

describe('the organization calendar (Phase 49a)', () => {
  it('keeps UTC for a generic organization', () => {
    expect(orgToday(FIRST_OF_QUARTER_IN_SYDNEY)).toBe('2026-06-30');
    expect(orgNow(FIRST_OF_QUARTER_IN_SYDNEY)).toBe(FIRST_OF_QUARTER_IN_SYDNEY);
  });

  it('uses the organization zone for an Australian organization, so a new quarter starts on time', () => {
    configureOrgCalendar('AU', 'Australia/Sydney');
    expect(orgToday(FIRST_OF_QUARTER_IN_SYDNEY)).toBe('2026-07-01');
    expect(orgNow(FIRST_OF_QUARTER_IN_SYDNEY).getUTCMonth()).toBe(6);
    expect(orgNow(FIRST_OF_QUARTER_IN_SYDNEY).getUTCDate()).toBe(1);
  });

  it('respects a zone without daylight saving (Perth is UTC+8)', () => {
    configureOrgCalendar('AU', 'Australia/Perth');
    expect(orgToday(FIRST_OF_QUARTER_IN_SYDNEY)).toBe('2026-06-30');
  });

  it('shows DD/MM/YYYY for an Australian organization whatever the browser locale', () => {
    configureOrgCalendar('AU', 'Australia/Sydney');
    expect(formatDate('2026-09-03')).toBe('03/09/2026');
    expect(formatDate(null)).toBe('—');
  });
});

describe('region-gated navigation (Phase 49a)', () => {
  const allow = () => true;

  it('never hides an entry with no region from either kind of organization', () => {
    const count = (region: string) => visibleNavGroups(allow, region).flatMap((g) => g.items).length;
    expect(count('AU')).toBe(count('GENERIC'));
  });
});
