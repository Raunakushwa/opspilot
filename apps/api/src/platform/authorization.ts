/**
 * Role-based authorization.
 *
 * The matrix lives in one place so it can be read, reviewed and tested as a
 * whole rather than inferred from checks scattered across route handlers. The
 * frontend may hide actions, but this is where they are actually prevented.
 */

export const ROLES = ['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Reading
  'incident:read',
  'document:read',
  'service:read',
  'organization:read',
  // Engineering work
  'incident:write',
  'comment:write',
  'document:write',
  'ai:investigate',
  // Approving AI proposals. Split deliberately: assigning an engineer is not
  // the same risk as rolling back a production deployment (ADR-007).
  'ai:approve:low_risk',
  'ai:approve:operational',
  // Administration
  'member:manage',
  'audit:read',
  'organization:write',
  'evaluation:run',
  // Ownership
  'owner:manage',
  'organization:delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'incident:read',
  'document:read',
  'service:read',
  'organization:read',
];

const ENGINEER: Permission[] = [
  ...VIEWER,
  'incident:write',
  'comment:write',
  'document:write',
  'ai:investigate',
  'ai:approve:low_risk',
];

const ADMIN: Permission[] = [
  ...ENGINEER,
  'ai:approve:operational',
  'member:manage',
  'audit:read',
  'organization:write',
  'evaluation:run',
];

const OWNER: Permission[] = [...ADMIN, 'owner:manage', 'organization:delete'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  ENGINEER: new Set(ENGINEER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

/**
 * Role ordering, used for one rule: nobody may grant or remove a role at or
 * above their own. Without it an ADMIN could promote themselves to OWNER.
 */
const RANK: Record<Role, number> = { VIEWER: 0, ENGINEER: 1, ADMIN: 2, OWNER: 3 };

export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

export function canAssignRole(actor: Role, role: Role): boolean {
  // An OWNER may create other OWNERs; everyone else may only assign strictly
  // below themselves.
  if (actor === 'OWNER') return true;
  return can(actor, 'member:manage') && outranks(actor, role);
}
