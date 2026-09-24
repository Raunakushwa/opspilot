'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AiPanel } from '@/components/ai-panel';
import { SeverityBadge, StatusBadge } from '@/components/badges';
import { Timeline } from '@/components/timeline';
import { Window } from '@/components/window';
import { useIncident, useMe, useTimeline, useUpdateIncident } from '@/hooks/api';
import { type Status } from '@/lib/types';
import { useSessionStore } from '@/stores/session';

const NEXT_STATUS: Status[] = ['INVESTIGATING', 'IDENTIFIED', 'MITIGATING', 'RESOLVED', 'CLOSED'];

export default function IncidentPage() {
  const params = useParams<{ incidentId: string }>();
  const incidentId = params.incidentId;
  const organizationId = useSessionStore((state) => state.organizationId);

  const me = useMe();
  const incident = useIncident(organizationId, incidentId);
  const timeline = useTimeline(organizationId, incidentId);
  const update = useUpdateIncident(organizationId, incidentId);

  const role = me.data?.memberships.find(
    (membership) => membership.organizationId === organizationId,
  )?.role;
  const canWrite = role === 'OWNER' || role === 'ADMIN' || role === 'ENGINEER';
  const canApproveOperational = role === 'OWNER' || role === 'ADMIN';

  if (incident.isPending) {
    return <p className="label-mono text-ink-muted">Loading…</p>;
  }
  if (incident.isError) {
    return <p className="text-sev1">This incident does not exist, or you cannot see it.</p>;
  }

  const data = incident.data;

  return (
    <div className="grid gap-6">
      <header className="border-b border-ink pb-4">
        <Link href="/incidents" className="label-mono text-ink-muted hover:text-ink">
          ← All incidents
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="label-mono text-ink-muted">INC-{data.number}</span>
          <SeverityBadge severity={data.severity} />
          <StatusBadge status={data.status} />
          {(data.services ?? []).map((service) => (
            <span key={service.id} className="label-mono border border-panel-edge px-1.5 py-0.5">
              {service.slug}
            </span>
          ))}
        </div>
        <h1 className="mt-3 text-4xl">{data.title}</h1>
        {data.description ? (
          <p className="mt-3 max-w-3xl text-ink-muted">{data.description}</p>
        ) : null}

        {canWrite ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="label-mono text-ink-muted">Set status</span>
            {NEXT_STATUS.filter((status) => status !== data.status).map((status) => (
              <button
                key={status}
                type="button"
                disabled={update.isPending || data.status === 'CLOSED'}
                onClick={() => {
                  // The version goes with the write: a stale edit is rejected
                  // rather than silently overwriting a colleague.
                  update.mutate({ version: data.version, changes: { status } });
                }}
                className="label-mono border border-ink px-2 py-1 disabled:opacity-40"
              >
                {status.toLowerCase()}
              </button>
            ))}
            {update.isError ? (
              <span className="label-mono text-sev1">
                Someone else changed this incident — reload.
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <AiPanel
          organizationId={organizationId}
          incidentId={incidentId}
          canInvestigate={canWrite}
          canApproveOperational={canApproveOperational}
        />

        <Window title="Timeline" meta={`${String(timeline.data?.data.length ?? 0)} events`}>
          <Timeline events={timeline.data?.data ?? []} />
        </Window>
      </div>
    </div>
  );
}
