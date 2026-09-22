import { describe, expect, it } from 'vitest';

import {
  can,
  canAssignRole,
  outranks,
  PERMISSIONS,
  permissionsFor,
  ROLES,
  type Role,
} from './authorization.js';

/**
 * The matrix is asserted as a whole rather than case by case: a new permission
 * must be placed deliberately for every role, and a widened role shows up here
 * as a diff instead of passing unnoticed.
 */
const EXPECTED: Record<Role, string[]> = {
  VIEWER: ['incident:read', 'document:read', 'service:read', 'organization:read'],
  ENGINEER: [
    'incident:read',
    'document:read',
    'service:read',
    'organization:read',
    'incident:write',
    'comment:write',
    'document:write',
    'ai:investigate',
    'ai:approve:low_risk',
  ],
  ADMIN: [
    'incident:read',
    'document:read',
    'service:read',
    'organization:read',
    'incident:write',
    'comment:write',
    'document:write',
    'ai:investigate',
    'ai:approve:low_risk',
    'ai:approve:operational',
    'member:manage',
    'audit:read',
    'organization:write',
    'evaluation:run',
  ],
  OWNER: [...PERMISSIONS],
};

describe('permission matrix', () => {
  it.each(ROLES)('%s holds exactly its documented permissions', (role) => {
    expect(permissionsFor(role).sort()).toEqual([...EXPECTED[role]].sort());
  });

  it('covers every permission for every role, with no undefined behaviour', () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(typeof can(role, permission)).toBe('boolean');
      }
    }
  });

  it('keeps roles strictly nested: each level includes the one below', () => {
    const order: Role[] = ['VIEWER', 'ENGINEER', 'ADMIN', 'OWNER'];
    for (let i = 1; i < order.length; i += 1) {
      const lower = permissionsFor(order[i - 1] as Role);
      const higher = permissionsFor(order[i] as Role);
      expect(higher).toEqual(expect.arrayContaining(lower));
      expect(higher.length).toBeGreaterThan(lower.length);
    }
  });

  it('never lets a VIEWER write anything', () => {
    const writes = PERMISSIONS.filter((p) => !p.endsWith(':read'));
    for (const permission of writes) {
      expect(can('VIEWER', permission)).toBe(false);
    }
  });

  it('separates low-risk AI approval from operational approval', () => {
    // An engineer may accept "assign this incident to me"; rolling back a
    // production deployment is an administrator's decision (ADR-007).
    expect(can('ENGINEER', 'ai:approve:low_risk')).toBe(true);
    expect(can('ENGINEER', 'ai:approve:operational')).toBe(false);
    expect(can('ADMIN', 'ai:approve:operational')).toBe(true);
  });

  it('reserves destructive organization actions for the owner', () => {
    expect(can('ADMIN', 'organization:delete')).toBe(false);
    expect(can('OWNER', 'organization:delete')).toBe(true);
  });
});

describe('role assignment', () => {
  it('prevents anyone below OWNER from granting their own rank or above', () => {
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ENGINEER')).toBe(true);
  });

  it('lets an owner grant any role, including another owner', () => {
    for (const role of ROLES) {
      expect(canAssignRole('OWNER', role)).toBe(true);
    }
  });

  it('does not let engineers or viewers manage members at all', () => {
    for (const actor of ['ENGINEER', 'VIEWER'] as const) {
      for (const role of ROLES) {
        expect(canAssignRole(actor, role)).toBe(false);
      }
    }
  });

  it('orders roles for the "cannot modify someone at or above you" rule', () => {
    expect(outranks('OWNER', 'ADMIN')).toBe(true);
    expect(outranks('ADMIN', 'ADMIN')).toBe(false);
    expect(outranks('ENGINEER', 'ADMIN')).toBe(false);
  });
});
