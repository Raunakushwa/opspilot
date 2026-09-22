export * from './columns.js';
export * from './identity.js';
export * from './org.js';

/**
 * Tables that carry tenant data and therefore need a row-level security policy.
 * The RLS migration and its tests both read this list, so adding a tenant table
 * without a policy fails the test suite.
 */
export const TENANT_TABLES = [
  'teams',
  'team_members',
  'projects',
  'services',
  'memberships',
] as const;
