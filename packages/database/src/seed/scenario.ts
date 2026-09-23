/**
 * The demo scenario, defined as data.
 *
 * It is deliberately solvable: a payment-service deployment at 09:12 changed
 * the database connection pool, error rate and pool-exhaustion log lines start
 * minutes later, an older postmortem describes the same failure mode, and a
 * runbook documents the rollback. An investigation that reads the evidence
 * should reach the right conclusion; one that guesses will not match the
 * citations.
 */

export const INCIDENT_START = new Date('2026-09-20T09:18:00Z');

export interface SeedService {
  slug: string;
  name: string;
  description: string;
  tier: string;
}

export const SERVICES: SeedService[] = [
  {
    slug: 'payment-service',
    name: 'payment-service',
    description: 'Card authorisation and capture. Owns the payments Postgres cluster.',
    tier: 'tier-1',
  },
  {
    slug: 'auth-service',
    name: 'auth-service',
    description: 'Sessions, tokens and login. Every request path depends on it.',
    tier: 'tier-1',
  },
  {
    slug: 'order-service',
    name: 'order-service',
    description: 'Order lifecycle. Calls payment-service synchronously at checkout.',
    tier: 'tier-2',
  },
  {
    slug: 'notification-service',
    name: 'notification-service',
    description: 'Email, SMS and webhook delivery. Consumes order events.',
    tier: 'tier-3',
  },
];

export interface SeedUser {
  email: string;
  displayName: string;
  role: 'OWNER' | 'ADMIN' | 'ENGINEER' | 'VIEWER';
}

export const USERS: SeedUser[] = [
  { email: 'ada@acme.test', displayName: 'Ada Okonkwo', role: 'OWNER' },
  { email: 'ravi@acme.test', displayName: 'Ravi Menon', role: 'ADMIN' },
  { email: 'grace@acme.test', displayName: 'Grace Lindqvist', role: 'ENGINEER' },
  { email: 'sam@acme.test', displayName: 'Sam Whitfield', role: 'ENGINEER' },
  { email: 'noor@acme.test', displayName: 'Noor Haddad', role: 'VIEWER' },
];

export interface SeedDeployment {
  service: string;
  version: string;
  commitSha: string;
  changeSummary: string;
  deployedBy: string;
  minutesBeforeIncident: number;
  status?: string;
}

/** The 09:12 payment-service deploy is the cause; the rest is background. */
export const DEPLOYMENTS: SeedDeployment[] = [
  {
    service: 'payment-service',
    version: 'v2026.9.20-1',
    commitSha: '41f2c9e',
    changeSummary:
      'Switch payments Postgres client to pgBouncer transaction pooling; reduce pool max from 40 to 8 per pod.',
    deployedBy: 'grace@acme.test',
    minutesBeforeIncident: 6,
  },
  {
    service: 'order-service',
    version: 'v2026.9.19-3',
    commitSha: 'b7741aa',
    changeSummary: 'Add idempotency keys to order submission.',
    deployedBy: 'sam@acme.test',
    minutesBeforeIncident: 1_470,
  },
  {
    service: 'auth-service',
    version: 'v2026.9.18-2',
    commitSha: 'd91c03f',
    changeSummary: 'Rotate JWT signing keys; no behavioural change.',
    deployedBy: 'ravi@acme.test',
    minutesBeforeIncident: 2_900,
  },
  {
    service: 'notification-service',
    version: 'v2026.9.17-1',
    commitSha: '5ac18b2',
    changeSummary: 'Batch webhook deliveries.',
    deployedBy: 'sam@acme.test',
    minutesBeforeIncident: 4_320,
  },
  {
    service: 'payment-service',
    version: 'v2026.9.16-4',
    commitSha: '0e7d5c1',
    changeSummary: 'Add refund reason codes.',
    deployedBy: 'grace@acme.test',
    minutesBeforeIncident: 5_760,
  },
  {
    service: 'payment-service',
    version: 'v2026.9.12-2',
    commitSha: 'cc4419d',
    changeSummary: 'Upgrade card network SDK.',
    deployedBy: 'grace@acme.test',
    minutesBeforeIncident: 11_520,
  },
  {
    service: 'auth-service',
    version: 'v2026.9.11-1',
    commitSha: 'af2201e',
    changeSummary: 'Session store connection tuning.',
    deployedBy: 'ravi@acme.test',
    minutesBeforeIncident: 12_960,
  },
  {
    service: 'order-service',
    version: 'v2026.9.09-1',
    commitSha: '7731bb0',
    changeSummary: 'Checkout retry backoff.',
    deployedBy: 'sam@acme.test',
    minutesBeforeIncident: 15_840,
  },
  {
    service: 'notification-service',
    version: 'v2026.9.08-2',
    commitSha: '9931fe4',
    changeSummary: 'Template rendering cache.',
    deployedBy: 'noor@acme.test',
    minutesBeforeIncident: 17_280,
  },
  {
    service: 'payment-service',
    version: 'v2026.9.05-1',
    commitSha: '2b90aa7',
    changeSummary: 'Structured logging for authorisation failures.',
    deployedBy: 'grace@acme.test',
    minutesBeforeIncident: 21_600,
  },
  {
    service: 'order-service',
    version: 'v2026.9.02-1',
    commitSha: 'e51c7d3',
    changeSummary: 'Failed rollout: bad migration, rolled back within 8 minutes.',
    deployedBy: 'sam@acme.test',
    minutesBeforeIncident: 25_920,
    status: 'ROLLED_BACK',
  },
];

export interface SeedDocument {
  title: string;
  type: 'RUNBOOK' | 'POSTMORTEM' | 'ARCHITECTURE' | 'TROUBLESHOOTING' | 'GENERAL';
  service?: string;
  tags: string[];
  content: string;
}

export const DOCUMENTS: SeedDocument[] = [
  {
    title: 'Runbook: rolling back payment-service',
    type: 'RUNBOOK',
    service: 'payment-service',
    tags: ['rollback', 'payments', 'deployment'],
    content: `# Rolling back payment-service

## When to roll back
Roll back when error rate exceeds 2% for more than five minutes and a deploy
went out in the preceding 30 minutes. Do not spend time on a forward fix while
customers are failing to pay.

## Procedure
1. Identify the current and previous release:
   \`opsctl deployments list payment-service --limit 2\`
2. Announce in #incident-response with the incident number.
3. Roll back:
   \`opsctl rollback payment-service --to <previous-version>\`
   The command is safe to re-run; it is a no-op once the target is live.
4. Watch \`payment_service_error_rate\` for five minutes. Expect recovery
   within two minutes of pods becoming ready.
5. If error rate does not fall, escalate to the payments on-call lead and
   consider failing open to the backup processor.

## After rollback
- Keep the incident open until error rate has been normal for 15 minutes.
- Capture the failing release notes in the postmortem.
- Never re-deploy the rolled-back version without a reproduction in staging.

## Cautions
Rolling back payment-service does **not** roll back database migrations. Check
whether the release included a migration before rolling back; if it did, page
the database on-call first.`,
  },
  {
    title: 'Postmortem: INC-88 payment-service connection pool exhaustion',
    type: 'POSTMORTEM',
    service: 'payment-service',
    tags: ['postmortem', 'payments', 'database', 'connection-pool'],
    content: `# Postmortem: INC-88 — payment-service connection pool exhaustion

**Date:** 2026-06-14  **Severity:** SEV2  **Duration:** 41 minutes

## Summary
payment-service returned 5xx on roughly 18% of authorisation requests after a
deploy reduced the per-pod database connection pool. Under normal traffic the
smaller pool was sufficient; at peak, requests queued for a connection, exceeded
the 2s acquisition timeout, and failed.

## Timeline
- 13:02 Deploy of v2026.6.14-2 reduces pool max from 50 to 10 per pod.
- 13:19 Error rate crosses 2%. Alert fires.
- 13:24 On-call correlates the error rate with the deploy.
- 13:31 Rollback started following the payment-service rollback runbook.
- 13:43 Error rate normal.

## Root cause
Connection pool sizing was treated as a per-service constant rather than a
function of pod count and peak concurrency. The new value was validated in
staging, which runs a third of production concurrency.

## What the logs looked like
\`\`\`
ERROR PaymentRepository: timeout acquiring connection from pool (waited 2001ms, pool=8/8 busy)
ERROR AuthorizationHandler: upstream_unavailable processing charge
\`\`\`

## Lessons
1. Pool size must be derived from measured peak concurrency, not copied.
2. Error rate alone did not point at the pool; the pool-exhaustion log line did.
3. Rollback was the right first action. Diagnosis continued after recovery.

## Action items
- Alert on connection acquisition wait time, not only error rate. (done)
- Document pool sizing in the payments architecture page. (done)`,
  },
  {
    title: 'Architecture: payment-service',
    type: 'ARCHITECTURE',
    service: 'payment-service',
    tags: ['architecture', 'payments', 'database'],
    content: `# payment-service architecture

## Responsibilities
Card authorisation, capture, refunds. Owns the payments PostgreSQL cluster and
is the only service permitted to write to it.

## Runtime shape
- 12 pods at normal load, 20 at peak (autoscaled on CPU).
- Each pod holds its own connection pool to the payments database.
- Synchronous callers: order-service (checkout), refund workers.

## Connection pool sizing
Total connections = pods x pool size, and must stay below the cluster's
max_connections (400) with headroom for migrations and admin sessions.

At 20 pods, a pool of 15 uses 300 connections — the intended steady state. Pool
sizes below 10 per pod have caused acquisition timeouts at peak (see INC-88).
pgBouncer transaction pooling changes this arithmetic and must be load-tested
before the per-pod pool is reduced.

## Failure modes
| Symptom | Usual cause |
| --- | --- |
| 5xx with \`timeout acquiring connection\` | pool too small for concurrency |
| 5xx with \`upstream_unavailable\` | card network timeout |
| Elevated latency, no errors | slow query or missing index |`,
  },
  {
    title: 'Runbook: auth-service session store failover',
    type: 'RUNBOOK',
    service: 'auth-service',
    tags: ['runbook', 'auth', 'redis'],
    content: `# auth-service session store failover

Sessions live in Redis. If the primary is unreachable, auth-service serves
reads from the replica and rejects new logins.

## Steps
1. Confirm the primary is actually down: \`opsctl redis status auth-sessions\`.
2. Promote the replica: \`opsctl redis failover auth-sessions\`.
3. Existing sessions survive; logins resume within 30 seconds.
4. Do not flush the session store: every user would be logged out.`,
  },
  {
    title: 'Troubleshooting: elevated 5xx on a service',
    type: 'TROUBLESHOOTING',
    tags: ['troubleshooting', 'general'],
    content: `# Elevated 5xx: first fifteen minutes

1. **Has anything shipped?** Check deployments for the affected service in the
   last hour. A deploy shortly before the onset is the most common cause.
2. **What do the logs say?** Group errors by message. One dominant error
   message usually names the failure directly.
3. **Which metric moved first?** Error rate, latency, saturation. The first to
   move points at the layer.
4. **Is it isolated?** If dependencies are healthy and only one service is
   failing, treat the deploy as the prime suspect.
5. **Mitigate before diagnosing.** Roll back or shed load first; the
   investigation can continue once customers are served.`,
  },
  {
    title: 'Postmortem: INC-102 notification backlog',
    type: 'POSTMORTEM',
    service: 'notification-service',
    tags: ['postmortem', 'notifications', 'queue'],
    content: `# Postmortem: INC-102 — notification backlog

**Date:** 2026-08-02  **Severity:** SEV3  **Duration:** 3 hours

Webhook batching increased per-delivery latency, the queue grew faster than it
drained, and notifications were delayed by up to two hours. No data was lost.

Root cause: batch size was tuned for throughput without checking the effect on
the slowest consumer. Fixed by capping batch size and adding a queue-depth
alert.`,
  },
  {
    title: 'Runbook: database migrations during an incident',
    type: 'RUNBOOK',
    tags: ['runbook', 'database', 'migrations'],
    content: `# Migrations during an incident

Never run a migration to fix a live incident unless it is the only mitigation
and the database on-call agrees.

A rollback does not revert migrations. If the release being rolled back
included one, confirm the old code can read the new schema before rolling back;
if it cannot, fix forward.`,
  },
];

export interface SeedIncident {
  title: string;
  description: string;
  severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
  status: 'INVESTIGATING' | 'IDENTIFIED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';
  service: string;
  daysAgo: number;
  assignee?: string;
}

/** Historical incidents, so "has this happened before?" has a real answer. */
export const HISTORICAL_INCIDENTS: SeedIncident[] = [
  {
    title: 'payment-service 5xx after pool size change',
    description:
      'Authorisation requests failed with connection acquisition timeouts after a deploy reduced the per-pod database pool. Resolved by rollback.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'payment-service',
    daysAgo: 98,
  },
  {
    title: 'Checkout latency above 2s at peak',
    description:
      'order-service checkout latency degraded during evening peak; traced to a missing index.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'order-service',
    daysAgo: 84,
  },
  {
    title: 'auth-service session store primary failover',
    description:
      'Redis primary became unreachable; replica promoted, logins restored in 4 minutes.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'auth-service',
    daysAgo: 71,
  },
  {
    title: 'Notification delivery backlog',
    description: 'Webhook batching caused a three-hour delivery delay.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'notification-service',
    daysAgo: 52,
  },
  {
    title: 'Card network timeouts from upstream provider',
    description: 'Provider incident caused upstream_unavailable errors for 22 minutes.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'payment-service',
    daysAgo: 45,
  },
  {
    title: 'Expired TLS certificate on internal gateway',
    description: 'Internal calls failed for 11 minutes after a certificate expired unnoticed.',
    severity: 'SEV1',
    status: 'CLOSED',
    service: 'auth-service',
    daysAgo: 39,
  },
  {
    title: 'Duplicate orders after retry storm',
    description:
      'Missing idempotency keys allowed duplicate order submission during a retry storm.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'order-service',
    daysAgo: 31,
  },
  {
    title: 'Refund processing delayed by worker crash loop',
    description:
      'A malformed refund record crashed the worker repeatedly until the poison message was removed.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'payment-service',
    daysAgo: 27,
  },
  {
    title: 'Elevated login failures after key rotation',
    description: 'A stale key cache rejected valid tokens for 6 minutes after rotation.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'auth-service',
    daysAgo: 21,
  },
  {
    title: 'Disk pressure on payments database replica',
    description:
      'WAL accumulation filled the replica disk; archiving resumed after the stuck process was restarted.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'payment-service',
    daysAgo: 18,
  },
  {
    title: 'Slow notification template rendering',
    description: 'A template cache miss storm increased rendering time.',
    severity: 'SEV4',
    status: 'CLOSED',
    service: 'notification-service',
    daysAgo: 15,
  },
  {
    title: 'order-service deploy rolled back for bad migration',
    description: 'A migration locked a hot table; the release was rolled back within 8 minutes.',
    severity: 'SEV2',
    status: 'CLOSED',
    service: 'order-service',
    daysAgo: 12,
  },
  {
    title: 'Intermittent 502s from the edge during rollout',
    description: 'Readiness probe timing caused brief 502s while pods restarted.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'auth-service',
    daysAgo: 9,
  },
  {
    title: 'Payments reconciliation job overran its window',
    description:
      'The nightly reconciliation job took three hours longer than usual after a data growth spike.',
    severity: 'SEV4',
    status: 'CLOSED',
    service: 'payment-service',
    daysAgo: 7,
  },
  {
    title: 'Webhook signature mismatch for one partner',
    description:
      'A partner rotated their secret without notice; deliveries failed until the new secret was stored.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'notification-service',
    daysAgo: 6,
  },
  {
    title: 'Checkout errors during card network maintenance',
    description: 'Planned maintenance caused a 9-minute window of authorisation failures.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'payment-service',
    daysAgo: 5,
  },
  {
    title: 'Stale feature flag caused inconsistent checkout',
    description: 'A flag left half-rolled-out produced inconsistent behaviour between pods.',
    severity: 'SEV3',
    status: 'CLOSED',
    service: 'order-service',
    daysAgo: 4,
  },
  {
    title: 'auth-service memory growth after dependency upgrade',
    description:
      'A dependency upgrade introduced a slow leak; pods restarted every few hours until it was reverted.',
    severity: 'SEV3',
    status: 'RESOLVED',
    service: 'auth-service',
    daysAgo: 3,
  },
  {
    title: 'Elevated queue depth on notification workers',
    description: 'A traffic spike outpaced worker concurrency; scaled out and recovered.',
    severity: 'SEV4',
    status: 'RESOLVED',
    service: 'notification-service',
    daysAgo: 2,
  },
  {
    title: 'Partial degradation from a noisy neighbour on shared nodes',
    description: 'CPU contention on shared nodes increased latency for order-service.',
    severity: 'SEV4',
    status: 'RESOLVED',
    service: 'order-service',
    daysAgo: 1,
  },
];

/** The open incident the demo investigates. */
export const DEMO_INCIDENT = {
  title: 'payment-service returning 5xx on card authorisation',
  description:
    'Error rate on payment-service crossed 2% at 09:18 and is climbing. Checkout is failing for a growing share of customers. No infrastructure alerts from the database team.',
  severity: 'SEV1' as const,
  status: 'INVESTIGATING' as const,
  service: 'payment-service',
};
