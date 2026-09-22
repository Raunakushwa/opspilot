import { relations } from 'drizzle-orm';
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, createdAt, orgId, primaryId, updatedAt } from './columns.js';

export const memberRole = pgEnum('member_role', ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER']);

export const organizations = pgTable('organizations', {
  id: primaryId(),
  name: text().notNull(),
  slug: citext().notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Users are global, not tenant-owned: one person may belong to several
 * organizations, and authentication happens before any organization is known.
 * Access to a user through the API is always mediated by a membership lookup.
 */
export const users = pgTable('users', {
  id: primaryId(),
  email: citext().notNull().unique(),
  passwordHash: text().notNull(),
  displayName: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: timestamp({ withTimezone: true }),
});

/** Membership is what makes a user part of an organization, and carries the role. */
export const memberships = pgTable(
  'memberships',
  {
    id: primaryId(),
    orgId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole().notNull().default('ENGINEER'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('memberships_org_user_key').on(table.orgId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

/**
 * Opaque session tokens (ADR-008). Only the hash is stored, so a database leak
 * does not hand over live sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text(),
    userAgent: text('user_agent'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    // Listing and revoking a user's live sessions.
    index('sessions_user_idx').on(table.userId, table.expiresAt),
  ],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.orgId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));
