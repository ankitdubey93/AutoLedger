import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ImportButton from '../components/imports/ImportButton';
import { safeReturnTo } from '../utils/safeReturnTo';

describe('ImportButton', () => {
  it('ImportButton links to the wizard with kind and returnTo', () => {
    render(
      <MemoryRouter>
        <ImportButton kind="VENDORS" returnTo="/vendors" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/migration-imports/new?kind=VENDORS&returnTo=%2Fvendors',
    );
  });

  it('safeReturnTo rejects protocol-relative and absolute URLs', () => {
    expect(safeReturnTo('//evil.test')).toBeNull();
    expect(safeReturnTo('https://x')).toBeNull();
    expect(safeReturnTo('\\x')).toBeNull();
    expect(safeReturnTo('/customers')).toBe('/customers');
  });
});
