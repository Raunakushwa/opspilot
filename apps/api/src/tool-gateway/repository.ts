import { type Database, withTenant } from '@opspilot/database';
import {
  deployments,
  documents,
  incidents,
  incidentServices,
  logEntries,
  metricPoints,
  services,
} from '@opspilot/database/schema';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

/**
 * Read queries behind the agent's tools.
 *
 * Every query runs inside the caller's tenant context, so the same row-level
 * security that protects the API protects the agent — there is no privileged
 * path for the model.
 */
export function createToolRepository(db: Database) {
  return {
    searchIncidents: async (orgId: string, query: string, limit: number) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            id: incidents.id,
            number: incidents.number,
            title: incidents.title,
            description: incidents.description,
            severity: incidents.severity,
            status: incidents.status,
            createdAt: incidents.createdAt,
            resolvedAt: incidents.resolvedAt,
            rank: sql<number>`ts_rank_cd(search_tsv, websearch_to_tsquery('english', ${query}))`,
          })
          .from(incidents)
          .where(
            and(
              eq(incidents.orgId, orgId),
              sql`search_tsv @@ websearch_to_tsquery('english', ${query})`,
            ),
          )
          .orderBy(desc(sql`ts_rank_cd(search_tsv, websearch_to_tsquery('english', ${query}))`))
          .limit(limit),
      ),

    getIncident: async (orgId: string, incidentId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [incident] = await tx
          .select()
          .from(incidents)
          .where(and(eq(incidents.orgId, orgId), eq(incidents.id, incidentId)))
          .limit(1);
        if (!incident) return undefined;
        const affected = await tx
          .select({ slug: services.slug, name: services.name })
          .from(incidentServices)
          .innerJoin(services, eq(services.id, incidentServices.serviceId))
          .where(eq(incidentServices.incidentId, incidentId));
        return { ...incident, services: affected };
      }),

    getService: async (orgId: string, slug: string) =>
      withTenant(db, orgId, async (tx) => {
        const [service] = await tx
          .select()
          .from(services)
          .where(and(eq(services.orgId, orgId), eq(services.slug, slug)))
          .limit(1);
        return service;
      }),

    getDeployments: async (orgId: string, slug: string, since: Date, limit: number) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            id: deployments.id,
            version: deployments.version,
            commitSha: deployments.commitSha,
            status: deployments.status,
            changeSummary: deployments.changeSummary,
            deployedBy: deployments.deployedBy,
            startedAt: deployments.startedAt,
            service: services.slug,
          })
          .from(deployments)
          .innerJoin(services, eq(services.id, deployments.serviceId))
          .where(
            and(
              eq(deployments.orgId, orgId),
              eq(services.slug, slug),
              gte(deployments.startedAt, since),
            ),
          )
          .orderBy(desc(deployments.startedAt))
          .limit(limit),
      ),

    getLogs: async (
      orgId: string,
      slug: string,
      options: { since: Date; levels: string[]; query?: string | undefined; limit: number },
    ) =>
      withTenant(db, orgId, (tx) => {
        const conditions = [
          eq(logEntries.orgId, orgId),
          eq(services.slug, slug),
          gte(logEntries.ts, options.since),
        ];
        if (options.levels.length > 0) {
          conditions.push(inArray(logEntries.level, options.levels));
        }
        if (options.query) {
          conditions.push(sql`message_tsv @@ websearch_to_tsquery('english', ${options.query})`);
        }
        return tx
          .select({
            ts: logEntries.ts,
            level: logEntries.level,
            message: logEntries.message,
            attributes: logEntries.attributes,
            service: services.slug,
          })
          .from(logEntries)
          .innerJoin(services, eq(services.id, logEntries.serviceId))
          .where(and(...conditions))
          .orderBy(desc(logEntries.ts))
          .limit(options.limit);
      }),

    /** Grouped counts, so the agent sees the shape of an error burst cheaply. */
    getLogPatterns: async (orgId: string, slug: string, since: Date, limit: number) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            message: logEntries.message,
            level: logEntries.level,
            occurrences: sql<number>`count(*)::int`,
            firstSeen: sql<Date>`min(${logEntries.ts})`,
            lastSeen: sql<Date>`max(${logEntries.ts})`,
          })
          .from(logEntries)
          .innerJoin(services, eq(services.id, logEntries.serviceId))
          .where(
            and(
              eq(logEntries.orgId, orgId),
              eq(services.slug, slug),
              gte(logEntries.ts, since),
              inArray(logEntries.level, ['ERROR', 'WARN']),
            ),
          )
          .groupBy(logEntries.message, logEntries.level)
          .orderBy(desc(sql`count(*)`))
          .limit(limit),
      ),

    getMetrics: async (orgId: string, slug: string, metric: string, since: Date) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            ts: metricPoints.ts,
            value: metricPoints.value,
            metric: metricPoints.metric,
            service: services.slug,
          })
          .from(metricPoints)
          .innerJoin(services, eq(services.id, metricPoints.serviceId))
          .where(
            and(
              eq(metricPoints.orgId, orgId),
              eq(services.slug, slug),
              eq(metricPoints.metric, metric),
              gte(metricPoints.ts, since),
            ),
          )
          .orderBy(metricPoints.ts),
      ),

    getPostmortems: async (orgId: string, query: string | undefined, limit: number) =>
      withTenant(db, orgId, (tx) => {
        const conditions = [eq(documents.orgId, orgId), eq(documents.type, 'POSTMORTEM')];
        if (query) {
          conditions.push(sql`${documents.title} ILIKE ${'%' + query + '%'}`);
        }
        return tx
          .select({
            id: documents.id,
            title: documents.title,
            tags: documents.tags,
            updatedAt: documents.updatedAt,
          })
          .from(documents)
          .where(and(...conditions))
          .orderBy(desc(documents.updatedAt))
          .limit(limit);
      }),
  };
}

export type ToolRepository = ReturnType<typeof createToolRepository>;
