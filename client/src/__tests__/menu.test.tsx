import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Menu from '../components/ui/Menu';

function renderMenu(onSelect: () => void = vi.fn()) {
  return render(
    <MemoryRouter>
      <Menu
        panelLabel="Test menu"
        items={[
          { label: 'Alpha', onSelect },
          { label: 'Beta', onSelect },
          { label: 'Gamma', onSelect },
        ]}
        trigger={({ buttonProps }) => (
          <button {...buttonProps} type="button">
            Open
          </button>
        )}
      />
    </MemoryRouter>,
  );
}

describe('Menu', () => {
  it('opens on click, sets aria-expanded, and focuses the first item', async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Test menu' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
  });

  it('ArrowDown moves focus to the next item, wrapping past the last', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('selecting an item runs its action and closes the menu', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderMenu(onSelect);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a click outside the menu closes it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <div>
          <Menu
            panelLabel="Test menu"
            items={[{ label: 'Alpha', onSelect: vi.fn() }]}
            trigger={({ buttonProps }) => (
              <button {...buttonProps} type="button">
                Open
              </button>
            )}
          />
          <button type="button">Outside</button>
        </div>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
