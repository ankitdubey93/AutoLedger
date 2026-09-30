import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomersPage from '../Pages/sales/CustomersPage';
import type { Customer } from '../services/fetchServices';

/**
 * The customer list. Doesn't depend on AuthContext or OrgContext — it talks
 * to fetchServices directly, like AccountsPage and JournalsPage.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const customer1: Customer = {
  id: 'cust-1',
  name: 'Northwind Traders',
  email: null,
  phone: null,
  billingAddress: null,
  taxNumber: null,
  notes: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockCustomerRoutes(customers: Customer[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/api/v1/customers')) {
      return Promise.resolve(
        jsonResponse(201, { success: true, customer: { ...customer1, id: 'cust-new', name: 'Contoso Ltd' } }),
      );
    }
    if (url.includes('/api/v1/customers')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: customers.length, customers }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCustomersPage(initialEntry = '/customers') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/customers" element={<CustomersPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CustomersPage', () => {
  it('lists customers and creates one', async () => {
    mockCustomerRoutes([customer1]);
    const user = userEvent.setup();
    renderCustomersPage();

    await screen.findByText('Northwind Traders');

    await user.click(screen.getByRole('button', { name: 'New customer' }));
    await user.type(screen.getByLabelText('Name'), 'Contoso Ltd');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find((call) => {
        const [input, init] = call as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/api/v1/customers');
      });
      expect(createCall).toBeDefined();
    });

    const createCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/api/v1/customers');
    });
    const body = JSON.parse((createCall as [RequestInfo | URL, RequestInit])[1].body as string) as {
      name: string;
    };
    expect(body.name).toBe('Contoso Ltd');
  });

  it('?new=1 opens the create form on mount', async () => {
    mockCustomerRoutes([customer1]);
    renderCustomersPage('/customers?new=1');

    await screen.findByText('Northwind Traders');
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('sorts by a column header and marks it with aria-sort', async () => {
    const zeta = { ...customer1, id: 'cust-z', name: 'Zeta Freight' };
    const alpha = { ...customer1, id: 'cust-a', name: 'Alpha Mills' };
    mockCustomerRoutes([zeta, alpha, customer1]);
    const user = userEvent.setup();
    renderCustomersPage();

    await screen.findByText('Alpha Mills');
    const names = () => screen.getAllByRole('link').map((l) => l.textContent);
    expect(names()).toEqual(['Alpha Mills', 'Northwind Traders', 'Zeta Freight']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Zeta Freight', 'Northwind Traders', 'Alpha Mills']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('pages a long list 25 at a time', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...customer1, id: `c-${String(i)}`, name: `Customer ${String(i + 1).padStart(2, '0')}` }));
    mockCustomerRoutes(many);
    const user = userEvent.setup();
    renderCustomersPage();

    await screen.findByText('Customer 01');
    expect(screen.queryByText('Customer 26')).toBeNull();
    expect(screen.getByText(/Showing 25 of 30 customers/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Customer 26')).toBeInTheDocument();
  });
});

