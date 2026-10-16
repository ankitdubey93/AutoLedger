import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ReportsPage from '../Pages/reports/ReportsPage';

/**
 * The reports index. It renders from a constant and links only, so it needs
 * no context or fetch stub under a bare MemoryRouter.
 */

describe('ReportsPage', () => {
  it('renders the six section headings and the cash flow link', () => {
    render(
      <MemoryRouter>
        <ReportsPage />
      </MemoryRouter>,
    );

    for (const heading of [
      'Financial statements',
      'Receivables & payables',
      'Sales & purchases',
      'Tax',
      'Ledger',
      'Audit',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: heading })).toBeTruthy();
    }

    const cashFlow = screen.getByRole('link', { name: /Cash flow statement/ });
    expect(cashFlow.getAttribute('href')).toBe('/reports/cash-flow');
  });
});
