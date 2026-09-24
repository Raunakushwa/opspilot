'use client';

import Link from 'next/link';
import { useState } from 'react';

import { SeverityBadge, StatusBadge } from '@/components/badges';
import { Window } from '@/components/window';
import { useIncidents } from '@/hooks/api';
import { useSessionStore } from '@/stores/session';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'INVESTIGATING', label: 'Investigating' },
  { value: 'MITIGATING', label: 'Mitigating' },
  { value: 'RESOLVED', label: 'Resolved' },
];

export default function IncidentsPage() {
  const organizationId = useSessionStore((state) => state.organizationId);
  const [status, setStatus] = useState('');
  const incidents = useIncidents(organizationId, status || undefined);

  const open = (incidents.data?.data ?? []).filter(
    (incident) => !['RESOLVED', 'CLOSED'].includes(incident.status),
  );

  return (
    <div className="grid gap-6">
      <header className="border-b border-ink pb-4">
        <p className="label-mono text-ink-muted">Incidents</p>
        <h1 className="mt-2 text-5xl">
          {open.length === 0 ? 'Nothing is on fire.' : `${String(open.length)} open.`}
        </h1>
      </header>

      <div className="flex gap-1">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => {
              setStatus(filter.value);
            }}
            className={`label-mono border px-2 py-1 ${
              status === filter.value ? 'border-ink bg-ink text-paper' : 'border-ink'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <Window title="Incident list" meta={`${String(incidents.data?.data.length ?? 0)} shown`}>
        {incidents.isPending ? <p className="label-mono text-ink-muted">Loading…</p> : null}
        {incidents.data?.data.length === 0 ? (
          <p className="label-mono text-ink-muted">No incidents match this filter.</p>
        ) : null}

        <ul className="grid">
          {(incidents.data?.data ?? []).map((incident) => (
            <li key={incident.id} className="border-b border-panel-edge last:border-b-0">
              <Link
                href={`/incidents/${incident.id}`}
                className="flex flex-wrap items-center gap-3 py-2 hover:bg-panel"
              >
                <span className="label-mono w-16 text-ink-muted">INC-{incident.number}</span>
                <SeverityBadge severity={incident.severity} />
                <StatusBadge status={incident.status} />
                <span className="flex-1 min-w-48">{incident.title}</span>
                <time className="font-mono text-[11px] text-ink-muted">
                  {new Date(incident.createdAt).toLocaleString()}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      </Window>
    </div>
  );
}
