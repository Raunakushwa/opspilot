'use client';

import { useQuery } from '@tanstack/react-query';

import { Window } from '@/components/window';
import { ApiError, apiFetch } from '@/lib/api';

interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, { status: 'ok' | 'unavailable'; latencyMs: number }>;
}

/**
 * Validates the response at the boundary: an accepted 503 could be a proxy
 * error page rather than a report. Zod contracts replace this in Phase 2.
 */
function isReadinessReport(value: unknown): value is ReadinessReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.status === 'ok' || candidate.status === 'unavailable') &&
    typeof candidate.checks === 'object' &&
    candidate.checks !== null
  );
}

const DOT = {
  ok: 'bg-ok',
  unavailable: 'bg-sev1',
} as const;

export function ApiStatus() {
  const { data, error, isPending } = useQuery({
    queryKey: ['readiness'],
    // 503 is an expected answer here: the body still names the failing dependency.
    queryFn: async () => {
      const body = await apiFetch<unknown>('/api/status', { acceptStatuses: [503] });
      if (!isReadinessReport(body)) {
        throw new Error('Unexpected status payload');
      }
      return body;
    },
    refetchInterval: 15_000,
  });

  return (
    <Window title="System status" meta={data?.status ?? (isPending ? 'checking' : 'error')}>
      {isPending ? <p className="label-mono text-ink-muted">Checking dependencies…</p> : null}

      {error ? (
        <div>
          <p className="text-sev1">API unreachable</p>
          <p className="label-mono mt-1 text-ink-muted">
            {error instanceof ApiError && error.requestId
              ? `request ${error.requestId}`
              : error.message}
          </p>
        </div>
      ) : null}

      {data ? (
        <dl className="grid gap-2">
          {Object.entries(data.checks).map(([name, check]) => (
            <div key={name} className="flex items-center gap-3 border-b border-panel-edge pb-2">
              <span
                aria-hidden
                className={`inline-block size-2 ${DOT[check.status]}`}
                data-testid={`dot-${name}`}
              />
              <dt className="label-mono flex-1">{name}</dt>
              <dd className="font-mono text-xs text-ink-muted">
                {check.status === 'ok' ? `${String(check.latencyMs)}ms` : 'unavailable'}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Window>
  );
}
