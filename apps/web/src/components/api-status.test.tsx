import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiStatus } from '@/components/api-status';

function renderWithQuery() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ApiStatus />
    </QueryClientProvider>,
  );
}

function mockFetch(response: Partial<Response> & { json: () => Promise<unknown> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), ...response }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiStatus', () => {
  it('lists each dependency with its latency', async () => {
    mockFetch({
      json: () =>
        Promise.resolve({
          status: 'ok',
          checks: {
            postgres: { status: 'ok', latencyMs: 3 },
            redis: { status: 'ok', latencyMs: 1 },
          },
        }),
    });

    renderWithQuery();

    expect(await screen.findByText('postgres')).toBeInTheDocument();
    expect(screen.getByText('3ms')).toBeInTheDocument();
    expect(screen.getByText('redis')).toBeInTheDocument();
  });

  it('marks an unavailable dependency without showing a latency', async () => {
    mockFetch({
      json: () =>
        Promise.resolve({
          status: 'unavailable',
          checks: { redis: { status: 'unavailable', latencyMs: 0 } },
        }),
    });

    renderWithQuery();

    // Appears twice: once as title-bar metadata, once as the check's value.
    expect(await screen.findAllByText('unavailable')).toHaveLength(2);
    expect(screen.getByTestId('dot-redis')).toHaveClass('bg-sev1');
  });

  it('surfaces the request id when the API returns a problem response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Headers({ 'x-request-id': 'req-123' }),
        json: () =>
          Promise.resolve({
            type: 'https://opspilot.dev/problems/bad_gateway',
            title: 'Bad Gateway',
            status: 502,
            code: 'bad_gateway',
            requestId: 'req-123',
          }),
      }),
    );

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText('API unreachable')).toBeInTheDocument();
    });
    expect(screen.getByText('request req-123')).toBeInTheDocument();
  });
});

describe('ApiStatus degraded responses', () => {
  it('renders the report when the API answers 503 with one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            status: 'unavailable',
            checks: { postgres: { status: 'ok', latencyMs: 2 } },
          }),
      }),
    );

    renderWithQuery();

    // Degraded is data, not an error: the panel must still name the dependencies.
    expect(await screen.findByText('postgres')).toBeInTheDocument();
    expect(screen.queryByText('API unreachable')).not.toBeInTheDocument();
  });
});
