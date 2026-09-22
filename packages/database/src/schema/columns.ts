import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

/**
 * Case-insensitive text. Email uniqueness must not depend on capitalisation,
 * and comparing `lower(email)` everywhere is easy to forget.
 */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/**
 * UUIDv7 primary key generated in the application: time-ordered, so inserts
 * stay at the right edge of the B-tree instead of scattering like UUIDv4, and
 * usable directly as a keyset pagination cursor.
 */
export const primaryId = () => uuid().primaryKey().$defaultFn(uuidv7);

/** Foreign key to the owning organization; present on every tenant-owned table. */
export const orgId = () => uuid('org_id').notNull();

export const createdAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`);

export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date());
