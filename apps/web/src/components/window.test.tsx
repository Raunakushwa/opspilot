import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Window } from '@/components/window';

describe('Window', () => {
  it('renders its title as a heading so panels are navigable', () => {
    render(
      <Window title="Incident timeline">
        <p>event</p>
      </Window>,
    );

    expect(screen.getByRole('heading', { name: 'Incident timeline' })).toBeInTheDocument();
    expect(screen.getByText('event')).toBeInTheDocument();
  });

  it('shows title-bar metadata only when provided', () => {
    const { rerender } = render(<Window title="Tool activity">body</Window>);
    expect(screen.queryByText('4 calls')).not.toBeInTheDocument();

    rerender(
      <Window title="Tool activity" meta="4 calls">
        body
      </Window>,
    );
    expect(screen.getByText('4 calls')).toBeInTheDocument();
  });
});
