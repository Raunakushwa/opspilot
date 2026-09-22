import { foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { citext, createdAt, orgId, primaryId, updatedAt } from './columns.js';
import { organizations, users } from './identity.js';

/**
 * Every tenant-owned table exposes UNIQUE (org_id, id) so that references from
 * other tenant tables can be composite. A composite foreign key makes a
 * cross-tenant reference unstorable rather than merely unlikely: the referenced
 * row must belong to the same organization as the referencing row.
 */
export const teams = pgTable(
  'teams',
  {
    id: primaryId(),
    orgId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    slug: citext().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('teams_org_slug_key').on(table.orgId, table.slug),
    unique('teams_org_id_key').on(table.orgId, table.id),
  ],
);

export const teamMembers = pgTable(
  'team_members',
  {
    orgId: orgId(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('team_members_pkey').on(table.teamId, table.userId),
    foreignKey({
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
      name: 'team_members_team_fk',
    }).onDelete('cascade'),
    index('team_members_user_idx').on(table.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: primaryId(),
    orgId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    key: citext().notNull(),
    ownerTeamId: uuid('owner_team_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('projects_org_key_key').on(table.orgId, table.key),
    unique('projects_org_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.ownerTeamId],
      foreignColumns: [teams.orgId, teams.id],
      name: 'projects_owner_team_fk',
    }).onDelete('set null'),
  ],
);

/** A deployable unit incidents are attached to (payment-service, auth-service…). */
export const services = pgTable(
  'services',
  {
    id: primaryId(),
    orgId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    slug: citext().notNull(),
    description: text(),
    tier: text(),
    repoUrl: text('repo_url'),
    projectId: uuid('project_id'),
    ownerTeamId: uuid('owner_team_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('services_org_slug_key').on(table.orgId, table.slug),
    unique('services_org_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'services_project_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.ownerTeamId],
      foreignColumns: [teams.orgId, teams.id],
      name: 'services_owner_team_fk',
    }).onDelete('set null'),
  ],
);
