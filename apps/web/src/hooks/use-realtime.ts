'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Keeps the open page in step with what other people are doing.
 *
 * Domain events arrive over SSE and invalidate the affected queries, so
 * TanStack Query refetches once instead of the page polling on a timer.
 */

const TOPIC_KEYS: Record<string, string[]> = {
  'incident.created': ['incidents'],
  'incident.updated': ['incidents', 'incident', 'timeline'],
  'incident.status.changed': ['incidents', 'incident', 'timeline'],
  'incident.severity.changed': ['incidents', 'incident', 'timeline'],
  'incident.assignee.changed': ['incidents', 'incident', 'timeline'],
  'ai.run.completed': ['runs', 'run', 'proposals', 'timeline'],
};

export function useRealtime(organizationId: string | null) {
  const client = useQueryClient();

  useEffect(() => {
    if (!organizationId) return;

    const source = new EventSource(`/api/orgs/${organizationId}/stream`, {
      withCredentials: true,
    });

    source.addEventListener('domain', (raw: MessageEvent<string>) => {
      let topic = '';
      try {
        topic = (JSON.parse(raw.data) as { topic?: string }).topic ?? '';
      } catch {
        return;
      }
      for (const key of TOPIC_KEYS[topic] ?? []) {
        void client.invalidateQueries({ queryKey: [key, organizationId] });
      }
    });

    return () => {
      source.close();
    };
  }, [organizationId, client]);
}
