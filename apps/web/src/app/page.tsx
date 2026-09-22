import { ApiStatus } from '@/components/api-status';
import { Window } from '@/components/window';

const PHASES = [
  { id: '01', label: 'Foundation', state: 'in progress' },
  { id: '02', label: 'Auth, organizations, RBAC', state: 'planned' },
  { id: '03', label: 'Incidents, timeline, audit log', state: 'planned' },
  { id: '04', label: 'AI investigation slice', state: 'planned' },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-10 border-b border-ink pb-6">
        <p className="label-mono text-ink-muted">OpsPilot · incident operations</p>
        <h1 className="mt-3 text-6xl">Nothing is on fire yet.</h1>
        <p className="mt-4 max-w-xl text-ink-muted">
          The foundation is being assembled. Services report their health below; incidents,
          knowledge base and the AI copilot arrive in later phases.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <ApiStatus />
        <Window title="Build phases" meta={`${String(PHASES.length)} tracked`}>
          <ol className="grid gap-2">
            {PHASES.map((phase) => (
              <li key={phase.id} className="flex items-baseline gap-3">
                <span className="label-mono text-accent-strong">{phase.id}</span>
                <span className="flex-1">{phase.label}</span>
                <span className="label-mono text-ink-muted">{phase.state}</span>
              </li>
            ))}
          </ol>
        </Window>
      </div>
    </main>
  );
}
