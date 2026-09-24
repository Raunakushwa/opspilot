'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api';
import {
  type AiRun,
  type AuditEntry,
  type Incident,
  type Me,
  type Proposal,
  type TimelineEvent,
} from '@/lib/types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/api/me'),
    // An expired session is an expected state, not a transient failure.
    retry: false,
    staleTime: 60_000,
  });
}

export function useIncidents(organizationId: string | null, status?: string) {
  const query = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['incidents', organizationId, status ?? 'all'],
    queryFn: () =>
      apiFetch<{ data: Incident[] }>(`/api/orgs/${organizationId ?? ''}/incidents${query}`),
    enabled: Boolean(organizationId),
  });
}

export function useIncident(organizationId: string | null, incidentId: string) {
  return useQuery({
    queryKey: ['incident', organizationId, incidentId],
    queryFn: () => apiFetch<Incident>(`/api/orgs/${organizationId ?? ''}/incidents/${incidentId}`),
    enabled: Boolean(organizationId),
  });
}

export function useTimeline(organizationId: string | null, incidentId: string) {
  return useQuery({
    queryKey: ['timeline', organizationId, incidentId],
    queryFn: () =>
      apiFetch<{ data: TimelineEvent[] }>(
        `/api/orgs/${organizationId ?? ''}/incidents/${incidentId}/events`,
      ),
    enabled: Boolean(organizationId),
  });
}

export function useRuns(organizationId: string | null, incidentId: string) {
  return useQuery({
    queryKey: ['runs', organizationId, incidentId],
    queryFn: () =>
      apiFetch<{ data: AiRun[] }>(
        `/api/orgs/${organizationId ?? ''}/incidents/${incidentId}/ai/runs`,
      ),
    enabled: Boolean(organizationId),
  });
}

export function useRun(organizationId: string | null, runId: string | null) {
  return useQuery({
    queryKey: ['run', organizationId, runId],
    queryFn: () => apiFetch<AiRun>(`/api/orgs/${organizationId ?? ''}/ai/runs/${runId ?? ''}`),
    enabled: Boolean(organizationId && runId),
  });
}

export function useProposals(organizationId: string | null, incidentId?: string) {
  const query = incidentId ? `?incidentId=${incidentId}` : '';
  return useQuery({
    queryKey: ['proposals', organizationId, incidentId ?? 'all'],
    queryFn: () =>
      apiFetch<{ data: Proposal[] }>(`/api/orgs/${organizationId ?? ''}/ai/proposals${query}`),
    enabled: Boolean(organizationId),
  });
}

export function useAuditLog(organizationId: string | null) {
  return useQuery({
    queryKey: ['audit', organizationId],
    queryFn: () =>
      apiFetch<{ data: AuditEntry[] }>(`/api/orgs/${organizationId ?? ''}/audit-logs?limit=100`),
    enabled: Boolean(organizationId),
  });
}

export function useStartInvestigation(organizationId: string | null, incidentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (question: string) =>
      apiFetch<{ runId: string; streamUrl: string }>(
        `/api/orgs/${organizationId ?? ''}/ai/investigations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ incidentId, question }),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['runs', organizationId, incidentId] });
      void client.invalidateQueries({ queryKey: ['timeline', organizationId, incidentId] });
    },
  });
}

export function useDecideProposal(organizationId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      apiFetch<{ execution: Record<string, unknown> | null }>(
        `/api/orgs/${organizationId ?? ''}/ai/proposals/${id}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      ),
    onSuccess: () => {
      // The decision changes the incident, its timeline and the audit log.
      for (const key of ['proposals', 'timeline', 'incident', 'audit']) {
        void client.invalidateQueries({ queryKey: [key, organizationId] });
      }
    },
  });
}

export function useUpdateIncident(organizationId: string | null, incidentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ version, changes }: { version: number; changes: Record<string, unknown> }) =>
      apiFetch<Incident>(`/api/orgs/${organizationId ?? ''}/incidents/${incidentId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          // Optimistic concurrency: the server rejects a stale write with 412.
          'if-match': `"${String(version)}"`,
        },
        body: JSON.stringify(changes),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['incident', organizationId, incidentId] });
      void client.invalidateQueries({ queryKey: ['timeline', organizationId, incidentId] });
      void client.invalidateQueries({ queryKey: ['incidents', organizationId] });
    },
  });
}

export function useLogout() {
  return useMutation({
    // Logout returns 204; there is no body to parse.
    mutationFn: async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    },
  });
}
