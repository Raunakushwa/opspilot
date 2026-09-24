'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { type Membership } from '@/lib/types';

/**
 * Which organization the user is currently acting in.
 *
 * Client state only: it selects which API path to call. The server still
 * verifies membership on every request, so a tampered value changes nothing
 * except which 404 you get.
 */
interface SessionState {
  organizationId: string | null;
  setOrganization: (id: string) => void;
  resolve: (memberships: Membership[]) => string | null;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      organizationId: null,
      setOrganization: (id) => {
        set({ organizationId: id });
      },
      resolve: (memberships) => {
        const current = get().organizationId;
        const stillMember = memberships.some((m) => m.organizationId === current);
        if (current && stillMember) return current;
        const fallback = memberships[0]?.organizationId ?? null;
        if (fallback !== current) set({ organizationId: fallback });
        return fallback;
      },
    }),
    { name: 'opspilot.session' },
  ),
);
