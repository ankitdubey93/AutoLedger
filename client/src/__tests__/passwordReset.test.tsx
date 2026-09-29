import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordPage from '../Pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '../Pages/auth/ResetPasswordPage';
import * as fetchServices from '../services/fetchServices';

vi.mock('../services/fetchServices');

afterEach(() => {
  vi.clearAllMocks();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  it('shows the same neutral confirmation after sending', async () => {
    vi.mocked(fetchServices.requestPasswordReset).mockResolvedValue({ success: true, message: 'x' });
    const user = userEvent.setup();
    renderAt('/forgot-password');

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText(/If an account exists for someone@example.com/)).toBeInTheDocument();
    expect(vi.mocked(fetchServices.requestPasswordReset)).toHaveBeenCalledWith('someone@example.com');
  });
});

describe('ResetPasswordPage', () => {
  it('sends the token from the link with the new password', async () => {
    vi.mocked(fetchServices.resetPassword).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderAt('/reset-password?token=abc123');

    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Password updated')).toBeInTheDocument();
    expect(vi.mocked(fetchServices.resetPassword)).toHaveBeenCalledWith('abc123', 'a-brand-new-password');
  });

  it('refuses mismatched passwords without calling the API', async () => {
    const user = userEvent.setup();
    renderAt('/reset-password?token=abc123');

    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-different-password');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('The two passwords do not match')).toBeInTheDocument();
    expect(vi.mocked(fetchServices.resetPassword)).not.toHaveBeenCalled();
  });

  it('offers a new link when the server says the token expired', async () => {
    vi.mocked(fetchServices.resetPassword).mockRejectedValue(new Error('This reset link has expired — request a new one'));
    const user = userEvent.setup();
    renderAt('/reset-password?token=abc123');

    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() => expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password'));
  });

  it('explains a link with no token instead of showing a form', () => {
    renderAt('/reset-password');
    expect(screen.getByText('The reset link is missing its token.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set new password' })).toBeNull();
  });
});
