import { type Severity, type Status } from '@/lib/types';

/** Severity and status are the only places colour carries meaning. */
const SEVERITY_STYLES: Record<Severity, string> = {
  SEV1: 'bg-sev1 text-paper',
  SEV2: 'bg-sev2 text-paper',
  SEV3: 'bg-sev3 text-ink',
  SEV4: 'bg-sev4 text-paper',
};

const STATUS_STYLES: Record<Status, string> = {
  INVESTIGATING: 'border-sev1 text-sev1',
  IDENTIFIED: 'border-sev2 text-sev2',
  MITIGATING: 'border-info text-info',
  RESOLVED: 'border-ok text-ok',
  CLOSED: 'border-ink-muted text-ink-muted',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`label-mono px-1.5 py-0.5 ${SEVERITY_STYLES[severity]}`}>{severity}</span>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`label-mono border px-1.5 py-0.5 ${STATUS_STYLES[status]}`}>
      {status.toLowerCase()}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  // Low confidence is shown as low, not hidden: an honest number is the point.
  const tone = value >= 0.7 ? 'bg-ok' : value >= 0.4 ? 'bg-sev3' : 'bg-sev1';
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-24 border border-ink" aria-hidden>
        <span className={`block h-full ${tone}`} style={{ width: `${String(percent)}%` }} />
      </span>
      <span className="label-mono">{percent}% confidence</span>
    </span>
  );
}
