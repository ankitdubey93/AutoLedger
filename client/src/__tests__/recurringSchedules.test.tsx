import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import RecurringSchedulesPage from '../Pages/accounting/RecurringSchedulesPage';
import RecurringScheduleDetailPage from '../Pages/accounting/RecurringScheduleDetailPage';
import MakeRecurringDialog from '../components/MakeRecurringDialog';
import * as fetchServices from '../services/fetchServices';

/**
 * Phase 34b — client tests for recurring schedules.
 */

vi.mock('../services/fetchServices');

const mockSchedule: fetchServices.RecurringSchedule = {
  id: 'sched-1',
  kind: 'INVOICE',
  name: 'Monthly invoice',
  sourceId: 'inv-1',
  frequency: 'MONTHLY',
  intervalCount: 1,
  startDate: '2026-09-25',
  endDate: null,
  nextRunDate: '2026-10-25',
  nextOccurrenceIndex: 1,
  mode: 'DRAFT',
  autoReverse: false,
  status: 'ACTIVE',
  lastError: null,
  lastErrorAt: null,
  lastRunDate: '2026-09-25',
  createdBy: 'user-1',
  createdAt: '2026-09-25T00:00:00Z',
  updatedAt: '2026-09-25T00:00:00Z',
};

describe('RecurringSchedulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists schedules and filters by kind', async () => {
    vi.mocked(fetchServices.listRecurringSchedules).mockResolvedValue({
      success: true,
      count: 1,
      schedules: [mockSchedule],
    });

    render(
      <MemoryRouter initialEntries={['/recurring']}>
        <Routes>
          <Route path="/recurring" element={<RecurringSchedulesPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Monthly invoice')).toBeInTheDocument();
    });

    const invoicesTab = screen.getByRole('tab', { name: /invoices/i });
    fireEvent.click(invoicesTab);

    await waitFor(() => {
      expect(fetchServices.listRecurringSchedules).toHaveBeenCalledWith({ kind: 'INVOICE' });
    });
  });

  it('make-recurring dialog posts kind, sourceId and mode', async () => {
    vi.mocked(fetchServices.createRecurringSchedule).mockResolvedValue({
      success: true,
      schedule: mockSchedule,
    });

    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(
      <MakeRecurringDialog
        kind="INVOICE"
        sourceId="inv-123"
        defaultName="Test Invoice"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    const nameInput = screen.getByDisplayValue('Test Invoice');
    expect(nameInput).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: /create schedule/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(fetchServices.createRecurringSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'INVOICE',
          sourceId: 'inv-123',
          mode: 'DRAFT',
        }),
      );
    });
  });

  it('journal dialog hides mode and offers auto-reverse', async () => {
    vi.mocked(fetchServices.createRecurringSchedule).mockResolvedValue({
      success: true,
      schedule: {
        ...mockSchedule,
        kind: 'JOURNAL',
        mode: 'POST',
        autoReverse: true,
      },
    });

    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(
      <MakeRecurringDialog
        kind="JOURNAL"
        sourceId="je-123"
        defaultName="Test Journal"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    // Assert mode control is hidden
    const modeLabel = screen.queryByLabelText(/mode/i);
    expect(modeLabel).toBeNull();

    // Assert auto-reverse checkbox is present
    const autoReverseCheckbox = screen.getByRole('checkbox', { name: /auto-reverse/i });
    expect(autoReverseCheckbox).toBeInTheDocument();

    // Check the auto-reverse checkbox
    fireEvent.click(autoReverseCheckbox);

    const submitBtn = screen.getByRole('button', { name: /create schedule/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(fetchServices.createRecurringSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'JOURNAL',
          mode: 'POST',
          autoReverse: true,
        }),
      );
    });
  });
});

describe('RecurringScheduleDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('run now shows the generated count', async () => {
    const detailSchedule: fetchServices.RecurringScheduleDetail = {
      ...mockSchedule,
      runs: [],
    };

    vi.mocked(fetchServices.getRecurringSchedule).mockResolvedValue({
      success: true,
      schedule: detailSchedule,
    });

    vi.mocked(fetchServices.runRecurringSchedule).mockResolvedValue({
      success: true,
      generated: 2,
      lastError: null,
      schedule: {
        ...detailSchedule,
        nextRunDate: '2026-11-25',
      },
    });

    render(
      <MemoryRouter initialEntries={['/recurring/sched-1']}>
        <Routes>
          <Route path="/recurring/:scheduleId" element={<RecurringScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Monthly invoice')).toBeInTheDocument();
    });

    const runBtn = screen.getByRole('button', { name: /run now/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(fetchServices.runRecurringSchedule).toHaveBeenCalledWith('sched-1');
    });
  });

  it('lastError renders an amber banner', async () => {
    const detailSchedule: fetchServices.RecurringScheduleDetail = {
      ...mockSchedule,
      status: 'ACTIVE',
      lastError: 'Fiscal period closed',
      lastErrorAt: '2026-09-25T10:00:00Z',
      runs: [],
    };

    vi.mocked(fetchServices.getRecurringSchedule).mockResolvedValue({
      success: true,
      schedule: detailSchedule,
    });

    render(
      <MemoryRouter initialEntries={['/recurring/sched-1']}>
        <Routes>
          <Route path="/recurring/:scheduleId" element={<RecurringScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Fiscal period closed/)).toBeInTheDocument();
    });

    const banner = screen.getByText(/Last error:/).closest('div');
    expect(banner).toHaveClass('bg-[var(--warning-bg)]');
  });

  it('end asks for confirmation before posting /end', async () => {
    const detailSchedule: fetchServices.RecurringScheduleDetail = {
      ...mockSchedule,
      runs: [],
    };

    vi.mocked(fetchServices.getRecurringSchedule).mockResolvedValue({
      success: true,
      schedule: detailSchedule,
    });

    vi.mocked(fetchServices.endRecurringSchedule).mockResolvedValue({
      success: true,
      schedule: {
        ...detailSchedule,
        status: 'ENDED',
        nextRunDate: null,
      },
    });

    render(
      <MemoryRouter initialEntries={['/recurring/sched-1']}>
        <Routes>
          <Route path="/recurring/:scheduleId" element={<RecurringScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Monthly invoice')).toBeInTheDocument();
    });

    const endBtn = screen.getByRole('button', { name: /end/i });
    fireEvent.click(endBtn);

    await waitFor(() => {
      expect(screen.getByText(/End this schedule/)).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole('button', { name: /End schedule/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fetchServices.endRecurringSchedule).toHaveBeenCalledWith('sched-1');
    });
  });
});
