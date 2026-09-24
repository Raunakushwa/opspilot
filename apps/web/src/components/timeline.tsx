import { type TimelineEvent } from '@/lib/types';

const LABELS: Record<string, string> = {
  'incident.created': 'Incident created',
  'incident.status.changed': 'Status changed',
  'incident.severity.changed': 'Severity changed',
  'incident.assignee.changed': 'Assignee changed',
  'incident.updated': 'Incident updated',
  'ai.investigation.started': 'AI investigation started',
  'ai.recommendation.generated': 'AI recommendation generated',
  'ai.action.executed': 'Action executed',
};

/** Payloads are jsonb from the database: render only what is really a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function describe(event: TimelineEvent): string {
  const payload = event.payload;
  if (event.type === 'incident.status.changed') {
    return `${text(payload.from)} → ${text(payload.to)}`;
  }
  if (event.type === 'incident.severity.changed') {
    return `${text(payload.from)} → ${text(payload.to)}`;
  }
  if (event.type === 'ai.recommendation.generated') {
    const confidence = typeof payload.confidence === 'number' ? payload.confidence : 0;
    return `${String(Math.round(confidence * 100))}% confidence, ${String(count(payload.proposals))} proposed action(s)`;
  }
  if (event.type === 'ai.action.executed') {
    return text(payload.actionType);
  }
  return text(payload.title);
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="label-mono text-ink-muted">No activity yet.</p>;
  }

  return (
    <ol className="grid gap-3">
      {events.map((event) => (
        <li key={event.id} className="border-l border-panel-edge pl-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="label-mono">
              {LABELS[event.type] ?? event.type}
              {event.actorType === 'AI' ? (
                <span className="ml-2 text-accent-strong">AI</span>
              ) : null}
            </span>
            <time className="font-mono text-[11px] text-ink-muted">
              {new Date(event.createdAt).toLocaleString()}
            </time>
          </div>
          <p className="text-sm text-ink-muted">
            {describe(event)}
            {event.actorName ? ` · ${event.actorName}` : ''}
          </p>
        </li>
      ))}
    </ol>
  );
}
