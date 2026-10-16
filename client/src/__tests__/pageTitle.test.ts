import { describe, expect, it } from 'vitest';
import { pageTitleFor } from '../utils/pageTitle';

describe('pageTitleFor', () => {
  it('uses the nav label for a list page and its detail pages', () => {
    expect(pageTitleFor('/invoices')).toBe('Invoices · AutoLedger');
    expect(pageTitleFor('/invoices/0b6f7c1e-1111-4222-8333-944445555666')).toBe('Invoices · AutoLedger');
  });

  it('prefers the longest matching nav entry', () => {
    expect(pageTitleFor('/inbox/review')).toBe('Review queue · AutoLedger');
    expect(pageTitleFor('/inbox/abc')).toBe('Bill inbox · AutoLedger');
    expect(pageTitleFor('/bank/rules')).toBe('Bank rules · AutoLedger');
  });

  it('the dashboard is exact-only, never a prefix of everything', () => {
    expect(pageTitleFor('/')).toBe('Dashboard · AutoLedger');
    expect(pageTitleFor('/nowhere')).toBe('AutoLedger');
  });

  it('exact titles and aliases win', () => {
    expect(pageTitleFor('/invoices/new')).toBe('New invoice · AutoLedger');
    expect(pageTitleFor('/login')).toBe('Sign in · AutoLedger');
    expect(pageTitleFor('/bills/abc')).toBe('Expenses · AutoLedger');
    expect(pageTitleFor('/manual-journals/')).toBe('Manual journals · AutoLedger');
  });
});
