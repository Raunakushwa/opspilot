'use client';

import { Window } from '@/components/window';
import { useAuditLog, useMe } from '@/hooks/api';
import { useSessionStore } from '@/stores/session';

export default function AuditPage() {
  const organizationId = useSessionStore((state) => state.organizationId);
  const me = useMe();
  const audit = useAuditLog(organizationId);

  const role = me.data?.memberships.find(
    (membership) => membership.organizationId === organizationId,
  )?.role;
  const allowed = role === 'OWNER' || role === 'ADMIN';

  return (
    <div className="grid gap-6">
      <header className="border-b border-ink pb-4">
        <p className="label-mono text-ink-muted">Audit log</p>
        <h1 className="mt-2 text-4xl">Every important action, permanently.</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Append-only: the application can insert rows here and read them, but a database trigger
          refuses updates and deletes.
        </p>
      </header>

      {!allowed ? (
        <p className="text-sev1">Your role cannot read the audit log.</p>
      ) : (
        <Window title="Recent activity" meta={`${String(audit.data?.data.length ?? 0)} entries`}>
          {audit.isPending ? <p className="label-mono text-ink-muted">Loading…</p> : null}
          <ul className="grid">
            {(audit.data?.data ?? []).map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-3 border-b border-panel-edge py-2 last:border-b-0"
              >
                <span className="label-mono w-56">{entry.action}</span>
                <span className="label-mono text-accent-strong">{entry.actorType}</span>
                <span className="flex-1 font-mono text-[11px] text-ink-muted">
                  {entry.resourceType}
                  {entry.resourceId ? `:${entry.resourceId.slice(0, 8)}` : ''}
                </span>
                <time className="font-mono text-[11px] text-ink-muted">
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        </Window>
      )}
    </div>
  );
}
