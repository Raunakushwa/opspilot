import { createHash } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

import { type Database } from '../client.js';
import {
  deployments,
  documents,
  documentVersions,
  incidentCounters,
  incidentEvents,
  incidents,
  incidentServices,
  logEntries,
  memberships,
  metricPoints,
  organizations,
  services,
  users,
} from '../schema/index.js';
import { withTenant, withoutTenant } from '../tenant.js';
import {
  DEMO_INCIDENT,
  DEPLOYMENTS,
  DOCUMENTS,
  HISTORICAL_INCIDENTS,
  INCIDENT_START,
  SERVICES,
  USERS,
} from './scenario.js';

/** Fixed namespace so every seeded id is stable across runs and machines. */
const NAMESPACE = '6f3a0f8e-9d4e-4a1b-9c2f-0f1f6b2e7a10';
const id = (name: string): string => uuidv5(name, NAMESPACE);

export const ORG_ID = id('org:acme');
const ORG_SLUG = 'acme';

/**
 * Every demo account shares this password. It is hashed here with the same
 * argon2id parameters the API uses, rather than pasted as a literal digest —
 * a hardcoded hash silently stops matching the moment those parameters change.
 */
export const DEMO_PASSWORD = 'demo-password-1234';
const ARGON2 = { memoryCost: 19456, timeCost: 3, parallelism: 1 } as const;

const minutes = (base: Date, delta: number): Date => new Date(base.getTime() + delta * 60_000);

export interface SeedResult {
  organizationId: string;
  demoIncidentId: string;
  counts: Record<string, number>;
}

/**
 * Populates a database with the demo organization.
 *
 * Idempotent: every row has a deterministic id and is upserted, so running it
 * twice (container restart, `make db-reset`, a test) converges on the same
 * state instead of duplicating history.
 */
export async function seed(db: Database): Promise<SeedResult> {
  const passwordHash = await hash(DEMO_PASSWORD, ARGON2);

  await withoutTenant(db, async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: ORG_ID, name: 'Acme Engineering', slug: ORG_SLUG })
      .onConflictDoNothing();

    // Updated rather than skipped: demo accounts must always be usable, and a
    // stale hash from an earlier seed would silently break every demo login.
    await tx
      .insert(users)
      .values(
        USERS.map((user) => ({
          id: id(`user:${user.email}`),
          email: user.email,
          displayName: user.displayName,
          passwordHash,
        })),
      )
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, displayName: sql`excluded.display_name` },
      });
  });

  return withTenant(db, ORG_ID, async (tx) => {
    await tx
      .insert(memberships)
      .values(
        USERS.map((user) => ({
          id: id(`membership:${user.email}`),
          orgId: ORG_ID,
          userId: id(`user:${user.email}`),
          role: user.role,
        })),
      )
      .onConflictDoNothing();

    await tx
      .insert(services)
      .values(
        SERVICES.map((service) => ({
          id: id(`service:${service.slug}`),
          orgId: ORG_ID,
          name: service.name,
          slug: service.slug,
          description: service.description,
          tier: service.tier,
        })),
      )
      .onConflictDoNothing();

    // --- deployments -------------------------------------------------------
    await tx
      .insert(deployments)
      .values(
        DEPLOYMENTS.map((deployment) => ({
          id: id(`deploy:${deployment.service}:${deployment.version}`),
          orgId: ORG_ID,
          serviceId: id(`service:${deployment.service}`),
          version: deployment.version,
          commitSha: deployment.commitSha,
          status: deployment.status ?? 'SUCCEEDED',
          changeSummary: deployment.changeSummary,
          deployedBy: deployment.deployedBy,
          startedAt: minutes(INCIDENT_START, -deployment.minutesBeforeIncident),
          finishedAt: minutes(INCIDENT_START, -deployment.minutesBeforeIncident + 4),
        })),
      )
      .onConflictDoNothing();

    // --- knowledge base ----------------------------------------------------
    for (const document of DOCUMENTS) {
      const documentId = id(`document:${document.title}`);
      const versionId = id(`document-version:${document.title}:1`);
      await tx
        .insert(documents)
        .values({
          id: documentId,
          orgId: ORG_ID,
          title: document.title,
          type: document.type,
          tags: document.tags,
          serviceId: document.service ? id(`service:${document.service}`) : null,
          currentVersionId: versionId,
          createdBy: id('user:ada@acme.test'),
        })
        .onConflictDoNothing();
      await tx
        .insert(documentVersions)
        .values({
          id: versionId,
          orgId: ORG_ID,
          documentId,
          versionNo: 1,
          title: document.title,
          content: document.content,
          contentHash: createHash('sha256').update(document.content).digest('hex'),
          createdBy: id('user:ada@acme.test'),
          ingestionStatus: 'PENDING',
        })
        .onConflictDoNothing();
    }

    // --- historical incidents ---------------------------------------------
    for (const [index, incident] of HISTORICAL_INCIDENTS.entries()) {
      const incidentId = id(`incident:${incident.title}`);
      const createdAt = minutes(INCIDENT_START, -incident.daysAgo * 24 * 60);
      await tx
        .insert(incidents)
        .values({
          id: incidentId,
          orgId: ORG_ID,
          number: index + 1,
          title: incident.title,
          description: incident.description,
          severity: incident.severity,
          status: incident.status,
          createdBy: id('user:grace@acme.test'),
          assignedTo: id('user:sam@acme.test'),
          createdAt,
          updatedAt: createdAt,
          resolvedAt: minutes(createdAt, 41),
          closedAt: incident.status === 'CLOSED' ? minutes(createdAt, 120) : null,
        })
        .onConflictDoNothing();
      await tx
        .insert(incidentServices)
        .values({
          orgId: ORG_ID,
          incidentId,
          serviceId: id(`service:${incident.service}`),
        })
        .onConflictDoNothing();
      await tx
        .insert(incidentEvents)
        .values({
          id: id(`incident-event:${incident.title}:created`),
          orgId: ORG_ID,
          incidentId,
          actorType: 'USER',
          actorId: id('user:grace@acme.test'),
          type: 'incident.created',
          payload: { title: incident.title, severity: incident.severity },
          createdAt,
        })
        .onConflictDoNothing();
    }

    // --- the open demo incident -------------------------------------------
    const demoIncidentId = id('incident:demo');
    const demoNumber = HISTORICAL_INCIDENTS.length + 1;
    await tx
      .insert(incidents)
      .values({
        id: demoIncidentId,
        orgId: ORG_ID,
        number: demoNumber,
        title: DEMO_INCIDENT.title,
        description: DEMO_INCIDENT.description,
        severity: DEMO_INCIDENT.severity,
        status: DEMO_INCIDENT.status,
        createdBy: id('user:grace@acme.test'),
        assignedTo: id('user:grace@acme.test'),
        createdAt: INCIDENT_START,
        updatedAt: INCIDENT_START,
      })
      .onConflictDoNothing();
    await tx
      .insert(incidentServices)
      .values({
        orgId: ORG_ID,
        incidentId: demoIncidentId,
        serviceId: id(`service:${DEMO_INCIDENT.service}`),
      })
      .onConflictDoNothing();
    await tx
      .insert(incidentEvents)
      .values({
        id: id('incident-event:demo:created'),
        orgId: ORG_ID,
        incidentId: demoIncidentId,
        actorType: 'USER',
        actorId: id('user:grace@acme.test'),
        type: 'incident.created',
        payload: { title: DEMO_INCIDENT.title, severity: DEMO_INCIDENT.severity },
        createdAt: INCIDENT_START,
      })
      .onConflictDoNothing();

    await tx
      .insert(incidentCounters)
      .values({ orgId: ORG_ID, nextNumber: demoNumber + 1 })
      .onConflictDoUpdate({
        target: incidentCounters.orgId,
        set: { nextNumber: demoNumber + 1 },
      });

    // --- metrics -----------------------------------------------------------
    // Error rate is flat until the deploy at -6 minutes, then climbs. The shape
    // is what makes the deployment correlation visible rather than asserted.
    const metricRows: (typeof metricPoints.$inferInsert)[] = [];
    for (const service of SERVICES) {
      for (let offset = -90; offset <= 30; offset += 5) {
        const isPayments = service.slug === 'payment-service';
        const errorRate =
          isPayments && offset >= -6 ? Math.min(0.12, 0.002 + (offset + 6) * 0.004) : 0.002;
        const latency = isPayments && offset >= -6 ? 420 + (offset + 6) * 22 : 180;
        metricRows.push(
          {
            orgId: ORG_ID,
            serviceId: id(`service:${service.slug}`),
            metric: 'error_rate',
            ts: minutes(INCIDENT_START, offset),
            value: Number(errorRate.toFixed(4)),
            labels: { unit: 'ratio' },
          },
          {
            orgId: ORG_ID,
            serviceId: id(`service:${service.slug}`),
            metric: 'latency_p95_ms',
            ts: minutes(INCIDENT_START, offset),
            value: latency,
            labels: { unit: 'ms' },
          },
        );
      }
    }
    await tx.insert(metricPoints).values(metricRows).onConflictDoNothing();

    // --- logs --------------------------------------------------------------
    // Deleted first so re-seeding does not multiply the log volume; log_entries
    // has a serial id rather than a deterministic one.
    await tx.delete(logEntries).where(eq(logEntries.orgId, ORG_ID));
    const logRows: (typeof logEntries.$inferInsert)[] = [];
    for (let offset = -60; offset <= 20; offset += 1) {
      const paymentsId = id('service:payment-service');
      if (offset >= -6) {
        logRows.push({
          orgId: ORG_ID,
          serviceId: paymentsId,
          ts: minutes(INCIDENT_START, offset),
          level: 'ERROR',
          message:
            'PaymentRepository: timeout acquiring connection from pool (waited 2001ms, pool=8/8 busy)',
          attributes: { pool_size: 8, waited_ms: 2001, release: 'v2026.9.20-1' },
          traceId: `trace-${String(1000 + offset)}`,
        });
        if (offset % 3 === 0) {
          logRows.push({
            orgId: ORG_ID,
            serviceId: paymentsId,
            ts: minutes(INCIDENT_START, offset),
            level: 'ERROR',
            message: 'AuthorizationHandler: upstream_unavailable processing charge',
            attributes: { release: 'v2026.9.20-1' },
            traceId: `trace-${String(2000 + offset)}`,
          });
        }
      } else if (offset % 5 === 0) {
        logRows.push({
          orgId: ORG_ID,
          serviceId: paymentsId,
          ts: minutes(INCIDENT_START, offset),
          level: 'INFO',
          message: 'AuthorizationHandler: charge authorised',
          attributes: { release: 'v2026.9.16-4' },
          traceId: `trace-${String(3000 + offset)}`,
        });
      }
      if (offset % 7 === 0) {
        logRows.push({
          orgId: ORG_ID,
          serviceId: id('service:order-service'),
          ts: minutes(INCIDENT_START, offset),
          level: offset >= -4 ? 'WARN' : 'INFO',
          message:
            offset >= -4
              ? 'CheckoutClient: payment-service returned 503, retrying'
              : 'CheckoutClient: order submitted',
          attributes: {},
          traceId: `trace-${String(4000 + offset)}`,
        });
      }
    }
    await tx.insert(logEntries).values(logRows);

    const counts = await tx.execute<{ table: string; total: number }>(sql`
      SELECT 'incidents' AS table, count(*)::int AS total FROM incidents
      UNION ALL SELECT 'documents', count(*)::int FROM documents
      UNION ALL SELECT 'deployments', count(*)::int FROM deployments
      UNION ALL SELECT 'log_entries', count(*)::int FROM log_entries
      UNION ALL SELECT 'metric_points', count(*)::int FROM metric_points
      UNION ALL SELECT 'services', count(*)::int FROM services
      UNION ALL SELECT 'users', count(*)::int FROM memberships
    `);

    return {
      organizationId: ORG_ID,
      demoIncidentId,
      counts: Object.fromEntries(counts.rows.map((row) => [row.table, row.total])),
    };
  });
}

export { uuidv7 };
