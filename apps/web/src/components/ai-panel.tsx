'use client';

import { useState } from 'react';

import { ConfidenceBar } from '@/components/badges';
import { Window } from '@/components/window';
import {
  useDecideProposal,
  useProposals,
  useRun,
  useRuns,
  useStartInvestigation,
} from '@/hooks/api';
import { useRunStream } from '@/hooks/use-run-stream';
import { ApiError } from '@/lib/api';
import { type InvestigationResult, type Proposal } from '@/lib/types';

interface AiPanelProps {
  organizationId: string | null;
  incidentId: string;
  canInvestigate: boolean;
  canApproveOperational: boolean;
}

const DEFAULT_QUESTION = 'Investigate this incident and explain the probable cause.';

/** Actions that change production need an administrator (ADR-007). */
const OPERATIONAL_ACTIONS = new Set(['ROLLBACK_DEPLOYMENT', 'RESTART_SERVICE']);

export function AiPanel({
  organizationId,
  incidentId,
  canInvestigate,
  canApproveOperational,
}: AiPanelProps) {
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);

  const runs = useRuns(organizationId, incidentId);
  const latestRunId = activeRunId ?? runs.data?.data[0]?.id ?? null;
  const run = useRun(organizationId, latestRunId);
  const proposals = useProposals(organizationId, incidentId);
  const start = useStartInvestigation(organizationId, incidentId);
  const decide = useDecideProposal(organizationId);
  const { events, finished } = useRunStream(streamUrl);

  // While a run is streaming the API has not stored the answer yet; once the
  // stream ends we re-read the run, which is the persisted source of truth.
  if (finished && streamUrl) {
    setStreamUrl(null);
    void run.refetch();
    void runs.refetch();
    void proposals.refetch();
  }

  const result = run.data?.result;
  const running = Boolean(streamUrl) || run.data?.status === 'RUNNING' || start.isPending;

  const onInvestigate = () => {
    start.mutate(question, {
      onSuccess: (response) => {
        setActiveRunId(response.runId);
        setStreamUrl(response.streamUrl);
      },
    });
  };

  return (
    <Window
      title="AI investigation"
      meta={run.data?.status ? run.data.status.toLowerCase() : 'idle'}
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <label className="label-mono text-ink-muted" htmlFor="ai-question">
            Question
          </label>
          <textarea
            id="ai-question"
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
            rows={2}
            disabled={!canInvestigate || running}
            className="border border-ink bg-paper p-2 font-sans text-sm disabled:opacity-60"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onInvestigate}
              disabled={!canInvestigate || running || question.trim().length < 5}
              className="border border-ink bg-ink px-3 py-1.5 text-paper disabled:opacity-40"
            >
              {running ? 'Investigating…' : 'Investigate with AI'}
            </button>
            {!canInvestigate ? (
              <span className="label-mono text-ink-muted">
                Your role cannot start investigations
              </span>
            ) : null}
            {start.error ? (
              <span className="label-mono text-sev1">
                {start.error instanceof ApiError ? start.error.problem.title : 'Failed to start'}
              </span>
            ) : null}
          </div>
        </div>

        {events.length > 0 ? <ProgressList events={events} /> : null}

        {result ? <ResultView result={result} /> : null}

        {run.data?.status === 'FAILED' ? (
          <p className="text-sev1">The investigation failed: {run.data.error ?? 'unknown error'}</p>
        ) : null}

        <ProposalList
          proposals={proposals.data?.data ?? []}
          canApproveOperational={canApproveOperational}
          onDecide={(id, decision) => {
            decide.mutate({ id, decision });
          }}
          pending={decide.isPending}
          error={decide.error instanceof ApiError ? decide.error.problem.title : null}
        />
      </div>
    </Window>
  );
}

function ProgressList({
  events,
}: {
  events: { id: string; event: string; label?: string | undefined }[];
}) {
  return (
    <ol className="grid gap-1 border border-panel-edge bg-panel p-3">
      {events
        .filter((event) => event.label ?? event.event === 'run.completed')
        .map((event) => (
          <li key={event.id} className="label-mono flex items-center gap-2">
            <span aria-hidden className="inline-block size-1.5 bg-accent-strong" />
            {event.label ?? 'Finished'}
          </li>
        ))}
    </ol>
  );
}

function ResultView({ result }: { result: InvestigationResult }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <ConfidenceBar value={result.confidence} />
        <p className="text-sm">{result.summary}</p>
      </div>

      {result.probable_causes.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="label-mono text-ink-muted">Probable causes</h3>
          <ol className="grid gap-1">
            {result.probable_causes.map((cause) => (
              <li key={cause.description} className="border-l border-panel-edge pl-3 text-sm">
                {cause.description}
                <span className="label-mono ml-2 text-ink-muted">
                  {Math.round(cause.confidence * 100)}%
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {result.evidence.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="label-mono text-ink-muted">Evidence</h3>
          <ul className="grid gap-1">
            {result.evidence.map((item) => (
              <li key={item.source_id} className="border-l border-panel-edge pl-3 text-sm">
                {item.explanation}
                <span className="label-mono ml-2 text-accent-strong">{item.source_type}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.citations.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="label-mono text-ink-muted">Sources</h3>
          <ul className="grid gap-1">
            {result.citations.map((citation) => (
              <li key={citation.source_id} className="font-mono text-[11px] text-ink-muted">
                {citation.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.recommended_actions.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="label-mono text-ink-muted">Recommended</h3>
          <ul className="grid gap-1">
            {result.recommended_actions.map((action) => (
              <li key={action.description} className="border-l border-panel-edge pl-3 text-sm">
                {action.description}
                <span className="label-mono ml-2 text-ink-muted">{action.urgency}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.not_inspected.length > 0 ? (
        <section className="grid gap-1">
          {/* Stated plainly: the assistant never implies it looked at more than it did. */}
          <h3 className="label-mono text-ink-muted">Not inspected</h3>
          <p className="text-sm text-ink-muted">{result.not_inspected.join(', ')}</p>
        </section>
      ) : null}
    </div>
  );
}

function ProposalList({
  proposals,
  canApproveOperational,
  onDecide,
  pending,
  error,
}: {
  proposals: Proposal[];
  canApproveOperational: boolean;
  onDecide: (id: string, decision: 'APPROVED' | 'REJECTED') => void;
  pending: boolean;
  error: string | null;
}) {
  if (proposals.length === 0) return null;

  return (
    <section className="grid gap-2">
      <h3 className="label-mono text-ink-muted">Proposed actions — approval required</h3>
      {error ? <p className="label-mono text-sev1">{error}</p> : null}
      <ul className="grid gap-2">
        {proposals.map((proposal) => {
          const needsAdmin = OPERATIONAL_ACTIONS.has(proposal.actionType);
          const blocked = needsAdmin && !canApproveOperational;
          const decided = proposal.status !== 'PROPOSED';
          return (
            <li key={proposal.id} className="border border-ink bg-panel p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="label-mono">{proposal.actionType}</span>
                <span className="label-mono text-ink-muted">{proposal.status.toLowerCase()}</span>
              </div>
              <p className="mt-1 text-sm">{proposal.rationale}</p>
              {Object.keys(proposal.arguments).length > 0 ? (
                <p className="mt-1 font-mono text-[11px] text-ink-muted">
                  {Object.entries(proposal.arguments)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(' ')}
                </p>
              ) : null}

              {proposal.executionResult ? (
                <p className="mt-2 border-l border-ok pl-2 font-mono text-[11px]">
                  {typeof proposal.executionResult.note === 'string'
                    ? proposal.executionResult.note
                    : 'executed'}
                </p>
              ) : null}

              {!decided ? (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={blocked || pending}
                    onClick={() => {
                      onDecide(proposal.id, 'APPROVED');
                    }}
                    className="border border-ink bg-ink px-2 py-1 text-paper disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      onDecide(proposal.id, 'REJECTED');
                    }}
                    className="border border-ink px-2 py-1 disabled:opacity-40"
                  >
                    Reject
                  </button>
                  {blocked ? (
                    <span className="label-mono text-ink-muted">Needs an admin to approve</span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
