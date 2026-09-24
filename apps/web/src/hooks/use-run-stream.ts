'use client';

import { useEffect, useRef, useState } from 'react';

export interface ProgressEvent {
  id: string;
  event: string;
  label?: string | undefined;
  payload: Record<string, unknown>;
}

/**
 * Follows an investigation's progress over SSE.
 *
 * `EventSource` reconnects on its own and resends Last-Event-ID, and the
 * server replays from a Redis stream — so a page reload mid-investigation
 * picks up where it left off rather than showing an empty panel.
 */
export function useRunStream(streamUrl: string | null) {
  const [state, setState] = useState<{
    url: string | null;
    events: ProgressEvent[];
    finished: boolean;
  }>({ url: null, events: [], finished: false });
  const sourceRef = useRef<EventSource | null>(null);

  // Resetting during render rather than in an effect: React applies it before
  // committing, so a new run never briefly shows the previous run's progress.
  if (state.url !== streamUrl) {
    setState({ url: streamUrl, events: [], finished: false });
  }

  const setEvents = (update: (current: ProgressEvent[]) => ProgressEvent[]) => {
    setState((current) => ({ ...current, events: update(current.events) }));
  };
  const setFinished = (finished: boolean) => {
    setState((current) => ({ ...current, finished }));
  };

  useEffect(() => {
    if (!streamUrl) return;

    const source = new EventSource(streamUrl, { withCredentials: true });
    sourceRef.current = source;

    const handle = (name: string) => (raw: MessageEvent<string>) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(raw.data) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      setEvents((current) => [
        ...current,
        {
          id: raw.lastEventId || String(current.length),
          event: name,
          label: typeof payload.label === 'string' ? payload.label : undefined,
          payload,
        },
      ]);
      if (name === 'run.completed' || name === 'run.failed') {
        setFinished(true);
        source.close();
      }
    };

    for (const name of [
      'run.started',
      'plan.created',
      'step.started',
      'tool.completed',
      'review.completed',
      'run.completed',
      'run.failed',
    ]) {
      source.addEventListener(name, handle(name) as EventListener);
    }

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [streamUrl]);

  return { events: state.events, finished: state.finished };
}
