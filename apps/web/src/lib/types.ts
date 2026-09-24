/** Shapes returned by the API. Mirrors the server's Zod schemas. */

export type Role = 'OWNER' | 'ADMIN' | 'ENGINEER' | 'VIEWER';
export type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
export type Status = 'INVESTIGATING' | 'IDENTIFIED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
}

export interface Me {
  user: { id: string; email: string; displayName: string };
  memberships: Membership[];
}

export interface Incident {
  id: string;
  number: number;
  title: string;
  description: string | null;
  severity: Severity;
  status: Status;
  assignedTo: string | null;
  version: number;
  createdAt: string;
  resolvedAt: string | null;
  services?: { id: string; name: string; slug: string }[];
}

export interface TimelineEvent {
  id: string;
  type: string;
  actorType: 'USER' | 'AI' | 'SYSTEM';
  actorName: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Citation {
  source_id: string;
  label: string;
  source_type: string;
}

export interface Evidence {
  source_type: string;
  source_id: string;
  explanation: string;
}

export interface ProbableCause {
  description: string;
  confidence: number;
  evidence_ids: string[];
}

export interface InvestigationResult {
  summary: string;
  confidence: number;
  probable_causes: ProbableCause[];
  evidence: Evidence[];
  recommended_actions: { description: string; urgency: string; rationale?: string }[];
  citations: Citation[];
  not_inspected: string[];
}

export interface AiRun {
  id: string;
  question: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  confidence: number | null;
  result: InvestigationResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Proposal {
  id: string;
  runId: string;
  incidentId: string | null;
  actionType: string;
  arguments: Record<string, unknown>;
  rationale: string;
  evidenceIds: string[];
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'EXPIRED';
  expiresAt: string;
  executionResult: Record<string, unknown> | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
