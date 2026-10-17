import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HistoryAndNotes from '../components/history/HistoryAndNotes';
import { addHistoryNote, listHistory, type HistoryEntry } from '../services/fetchServices';

/**
 * Phase 46c — the History & notes panel. The service calls are mocked; the
 * panel is collapsed by default and must not fetch until it is expanded.
 */

const perms = vi.hoisted(() => ({ granted: true }));

vi.mock('../context/AuthContext', () => ({
  useCan: () => () => perms.granted,
}));

vi.mock('../services/fetchServices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/fetchServices')>();
  return { ...actual, listHistory: vi.fn(), addHistoryNote: vi.fn() };
});

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h-1',
    kind: 'EVENT',
    action: 'ISSUED',
    summary: 'Issued invoice INV-000042',
    details: null,
    actorUserId: 'user-1',
    actorName: 'Ankit',
    createdAt: '2026-06-01T10:00:00Z',
    ...overrides,
  };
}

const listHistoryMock = vi.mocked(listHistory);
const addHistoryNoteMock = vi.mocked(addHistoryNote);

describe('HistoryAndNotes', () => {
  beforeEach(() => {
    perms.granted = true;
    listHistoryMock.mockReset();
    addHistoryNoteMock.mockReset();
  });

  it('is collapsed by default and fetches only once expanded', async () => {
    listHistoryMock.mockResolvedValue({
      success: true,
      count: 2,
      history: [entry(), entry({ id: 'h-2', action: 'PAID', summary: 'Payment received' })],
    });
    render(<HistoryAndNotes basePath="/invoices" entityId="inv-1" notePermission="invoices.edit" />);

    expect(listHistoryMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Issued invoice INV-000042')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /History & notes/ }));

    await waitFor(() => {
      expect(screen.getByText('Issued invoice INV-000042')).toBeTruthy();
    });
    expect(screen.getByText('Payment received')).toBeTruthy();
    expect(listHistoryMock).toHaveBeenCalledWith('/invoices', 'inv-1');
  });

  it('shows System when the actor is null', async () => {
    listHistoryMock.mockResolvedValue({
      success: true,
      count: 1,
      history: [entry({ actorUserId: null, actorName: null, summary: 'Overdue reminder sent' })],
    });
    render(<HistoryAndNotes basePath="/invoices" entityId="inv-1" notePermission="invoices.edit" />);
    await userEvent.click(screen.getByRole('button', { name: /History & notes/ }));

    const row = (await screen.findByText('Overdue reminder sent')).closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('System')).toBeTruthy();
  });

  it('adds a note and prepends the returned entry', async () => {
    listHistoryMock.mockResolvedValue({ success: true, count: 1, history: [entry()] });
    addHistoryNoteMock.mockResolvedValue({
      success: true,
      entry: entry({ id: 'h-note', kind: 'NOTE', action: 'NOTE', summary: 'Hello', actorName: 'Ankit' }),
    });
    render(<HistoryAndNotes basePath="/invoices" entityId="inv-1" notePermission="invoices.edit" />);
    await userEvent.click(screen.getByRole('button', { name: /History & notes/ }));
    await screen.findByText('Issued invoice INV-000042');

    await userEvent.type(screen.getByRole('textbox'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() => {
      expect(addHistoryNoteMock).toHaveBeenCalledWith('/invoices', 'inv-1', 'Hello');
    });
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Hello');
    expect(items[1]?.textContent).toContain('Issued invoice INV-000042');
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('shows no textarea without the note permission', async () => {
    perms.granted = false;
    listHistoryMock.mockResolvedValue({ success: true, count: 0, history: [] });
    render(<HistoryAndNotes basePath="/bills" entityId="bill-1" notePermission="bills.edit" />);
    await userEvent.click(screen.getByRole('button', { name: /History & notes/ }));

    await screen.findByText('No history yet.');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
  });
});
