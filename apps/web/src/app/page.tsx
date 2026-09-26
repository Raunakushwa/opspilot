import Link from 'next/link';
import { type Metadata } from 'next';

import {
  DarkWindow,
  Eyebrow,
  GhostLink,
  PrimaryLink,
  Section,
} from '@/components/landing/primitives';

export const metadata: Metadata = {
  title: 'OpsPilot — incident investigation with receipts',
  description:
    'A multi-tenant incident platform whose AI copilot investigates, cites what it actually read, and proposes remediation a human approves.',
};

const STATS = [
  { value: '3', label: 'independent layers of tenant isolation' },
  { value: '0', label: 'write tools the agent can reach' },
  { value: '100%', label: 'citations checked against a ledger, in code' },
  { value: '252', label: 'tests, none of them mocking a database' },
];

const PROGRESS = [
  'Reading the incident',
  'Planning the investigation',
  'Checking deployment history',
  'Grouping error patterns',
  'Inspecting metrics',
  'Searching runbooks and postmortems',
  'Analysing the evidence',
];

const EVAL = [
  { mode: 'hybrid', recall: '1.00', mrr: '1.00', ndcg: '1.00', best: true },
  { mode: 'vector only', recall: '0.94', mrr: '0.94', ndcg: '0.91', best: false },
  { mode: 'keyword only', recall: '1.00', mrr: '1.00', ndcg: '1.00', best: false },
];

const STACK = [
  { group: 'Product', items: 'Next.js · React · TanStack Query · Tailwind' },
  { group: 'API', items: 'Fastify · Drizzle · PostgreSQL with row-level security · Redis' },
  { group: 'Jobs', items: 'BullMQ · transactional outbox · dead-letter queue' },
  { group: 'AI', items: 'FastAPI · LangGraph · Pydantic · Qdrant · fastembed' },
  { group: 'Platform', items: 'Docker Compose · GitHub Actions · Testcontainers' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-night text-paper">
      <header className="sticky top-0 z-20 border-b border-night-line bg-night/85 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <span className="label-mono border border-paper px-2 py-1">OpsPilot</span>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="#how"
              className="label-mono hidden px-3 py-1.5 opacity-70 hover:opacity-100 sm:block"
            >
              How it works
            </Link>
            <Link
              href="#evidence"
              className="label-mono hidden px-3 py-1.5 opacity-70 hover:opacity-100 sm:block"
            >
              Evidence
            </Link>
            <Link
              href="/login"
              className="label-mono border border-paper bg-paper px-3 py-1.5 text-ink"
            >
              Sign in
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero ---------------------------------------------------------- */}
      <section className="relative overflow-hidden">
        {/* The artwork sits to the right; the copy gets a clean, dark column. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-cover bg-right opacity-95"
          style={{ backgroundImage: 'url(/art/hero.svg)' }}
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-r from-night via-night/80 to-night/10"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-night/40 via-transparent to-night"
        />
        <div className="relative mx-auto max-w-6xl px-6 pb-16 pt-20 md:pb-20 md:pt-28">
          <Eyebrow>Multi-tenant incident operations</Eyebrow>
          <h1 className="mt-5 max-w-3xl text-5xl leading-[0.95] md:text-7xl">
            Your incident, investigated. With receipts.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-paper/75">
            OpsPilot reads your deployments, logs, metrics and your own runbooks, then explains what
            probably broke — citing only the things it actually opened. When action is warranted it
            proposes it, and a human with the right role decides.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <PrimaryLink href="/login">Open the demo</PrimaryLink>
            <GhostLink href="https://github.com/Raunakushwa/opspilot">Read the code</GhostLink>
          </div>
          <p className="label-mono mt-6 opacity-50">demo · ada@acme.test · demo-password-1234</p>
        </div>
      </section>

      {/* Stats --------------------------------------------------------- */}
      <Section className="bg-night">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((stat) => (
            <div key={stat.label}>
              <p className="font-display text-5xl tracking-tight">{stat.value}</p>
              <p className="mt-2 text-sm text-paper/60">{stat.label}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* How it works -------------------------------------------------- */}
      <Section id="how">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <Eyebrow tone="mint">How an investigation runs</Eyebrow>
            <h2 className="mt-4 text-4xl md:text-5xl">
              It decides what to look at, then shows its working.
            </h2>
            <p className="mt-5 text-paper/70">
              A planner chooses which sources are worth reading for the question asked — a runbook
              question does not drag metrics and logs along with it. The chosen reads run at the
              same time, and each one streams back as it lands.
            </p>
            <p className="mt-4 text-paper/70">
              Progress is a description of activity, never the model&rsquo;s private reasoning.
            </p>
          </div>

          <DarkWindow title="AI investigation" meta="running">
            <ol className="grid gap-2">
              {PROGRESS.map((step, index) => (
                <li key={step} className="label-mono flex items-center gap-3">
                  <span
                    aria-hidden
                    className={`inline-block size-1.5 ${index < 6 ? 'bg-mint' : 'bg-accent'}`}
                  />
                  <span className={index < 6 ? 'opacity-90' : 'opacity-60'}>{step}</span>
                </li>
              ))}
            </ol>
            <div className="mt-5 border-t border-night-line pt-4">
              <p className="label-mono opacity-60">Result</p>
              <p className="mt-2 text-sm text-paper/85">
                A deployment reduced the connection pool from 40 to 8 per pod, causing acquisition
                timeouts that surfaced as 5xx. A prior incident shows the same failure mode.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <span aria-hidden className="h-2 w-24 border border-paper/40">
                  <span className="block h-full w-[70%] bg-mint" />
                </span>
                <span className="label-mono opacity-70">70% confidence</span>
              </div>
            </div>
          </DarkWindow>
        </div>
      </Section>

      {/* Provenance ---------------------------------------------------- */}
      <Section id="evidence">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image does not optimise SVG; this is decorative vector art */}
          <img src="/art/ledger.svg" alt="" className="w-full max-w-xl" />
          <div>
            <Eyebrow tone="sky">Provenance</Eyebrow>
            <h2 className="mt-4 text-4xl md:text-5xl">It cannot cite what it did not read.</h2>
            <p className="mt-5 text-paper/70">
              Every tool call and every retrieved passage enters a ledger with an identifier. The
              answer may only reference identifiers from that run, and the check runs in code — not
              as an instruction in a prompt.
            </p>
            <ul className="mt-6 grid gap-3 text-sm">
              {[
                'A source that does not exist is deleted before anyone sees it',
                'Confidence is capped when the support turns out to be invented',
                'A source that failed or returned nothing is listed as not inspected',
                'Retrieved documents are data, never instructions',
              ].map((line) => (
                <li key={line} className="flex gap-3 border-l border-night-line pl-4 text-paper/80">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Approval ------------------------------------------------------ */}
      <Section>
        <Eyebrow tone="peach">Human in the loop</Eyebrow>
        <h2 className="mt-4 max-w-3xl text-4xl md:text-5xl">
          The agent proposes. A person decides. The system remembers.
        </h2>
        <p className="mt-5 max-w-2xl text-paper/70">
          There are no write tools behind the model at all. A rollback is a proposal until someone
          with the right role approves it — and then the API executes it as that person, after
          re-checking the target against the current state.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative vector art, not a photo */}
        <img src="/art/gate.svg" alt="" className="mt-10 w-full max-w-3xl" />
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {[
            {
              title: 'Roles, not vibes',
              body: 'An engineer can accept an assignment. Rolling back production needs an administrator.',
            },
            {
              title: 'Arguments re-derived',
              body: 'The service comes from the incident and the target release from deployment history, never from the model.',
            },
            {
              title: 'Append-only audit',
              body: 'Updates and deletes are revoked and refused by a trigger. History cannot be rewritten.',
            },
          ].map((card) => (
            <div key={card.title} className="border border-night-line p-5">
              <p className="label-mono text-lilac">{card.title}</p>
              <p className="mt-3 text-sm text-paper/75">{card.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Evaluation ---------------------------------------------------- */}
      <Section>
        <div className="grid gap-12 lg:grid-cols-2">
          <div>
            <Eyebrow tone="mint">Measured, not asserted</Eyebrow>
            <h2 className="mt-4 text-4xl md:text-5xl">Retrieval quality is a number.</h2>
            <p className="mt-5 text-paper/70">
              Eight questions an on-call engineer would actually ask, each labelled with the
              documents a competent responder would want. The metrics come from the ranking alone,
              so no model judges them.
            </p>
            <p className="mt-4 text-sm text-paper/55">
              Eight questions over seven documents: real and reproducible, and not a benchmark.
              Answer quality is unmeasured — that needs a judge model.
            </p>
          </div>

          <DarkWindow title="pnpm evaluate:rag" meta="k=4">
            <table className="w-full text-left">
              <thead>
                <tr className="label-mono opacity-60">
                  <th className="pb-2 font-normal">mode</th>
                  <th className="pb-2 font-normal">recall</th>
                  <th className="pb-2 font-normal">MRR</th>
                  <th className="pb-2 font-normal">nDCG</th>
                </tr>
              </thead>
              <tbody className="font-mono text-sm">
                {EVAL.map((row) => (
                  <tr key={row.mode} className="border-t border-night-line">
                    <td className={`py-2 ${row.best ? 'text-mint' : 'text-paper/75'}`}>
                      {row.mode}
                    </td>
                    <td className={row.best ? 'text-mint' : 'text-paper/75'}>{row.recall}</td>
                    <td className={row.best ? 'text-mint' : 'text-paper/75'}>{row.mrr}</td>
                    <td className={row.best ? 'text-mint' : 'text-paper/75'}>{row.ndcg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-sm text-paper/60">
              Vector search alone misses the architecture document for{' '}
              <span className="font-mono text-paper/80">
                &ldquo;what does &lsquo;timeout acquiring connection from pool&rsquo; mean?&rdquo;
              </span>{' '}
              — a near-exact token match that embeddings blur.
            </p>
          </DarkWindow>
        </div>
      </Section>

      {/* Stack --------------------------------------------------------- */}
      <Section>
        <Eyebrow tone="sky">Built with</Eyebrow>
        <h2 className="mt-4 text-4xl md:text-5xl">Four services, each with a reason.</h2>
        <dl className="mt-10 grid gap-px border border-night-line bg-night-line">
          {STACK.map((row) => (
            <div key={row.group} className="grid gap-2 bg-night p-5 sm:grid-cols-[180px_1fr]">
              <dt className="label-mono text-paper/60">{row.group}</dt>
              <dd className="text-paper/85">{row.items}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* Footer -------------------------------------------------------- */}
      <footer className="border-t border-night-line px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-2xl text-4xl">Open the incident and ask it why.</h2>
          <div className="mt-8 flex flex-wrap gap-3">
            <PrimaryLink href="/login">Open the demo</PrimaryLink>
            <GhostLink href="https://github.com/Raunakushwa/opspilot">Read the code</GhostLink>
          </div>
          <p className="label-mono mt-12 opacity-45">
            A portfolio project. The logs, metrics and deployments are seeded, and an approved
            rollback is recorded rather than performed.
          </p>
        </div>
      </footer>
    </div>
  );
}
