'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { useLogout, useMe } from '@/hooks/api';
import { useSessionStore } from '@/stores/session';

const NAV = [
  { href: '/incidents', label: 'Incidents' },
  { href: '/audit', label: 'Audit log' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const logout = useLogout();
  const { organizationId, setOrganization, resolve } = useSessionStore();

  // Memoised so the effect below does not re-run on every render.
  const memberships = useMemo(() => me.data?.memberships ?? [], [me.data]);

  useEffect(() => {
    // The server is the authority; this only avoids rendering an empty shell
    // to someone whose session has expired.
    if (me.isError) router.replace('/login');
  }, [me.isError, router]);

  useEffect(() => {
    if (memberships.length > 0) resolve(memberships);
  }, [memberships, resolve]);

  if (me.isPending) {
    return <p className="label-mono p-6 text-ink-muted">Loading…</p>;
  }

  const active = memberships.find((membership) => membership.organizationId === organizationId);

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink px-4 py-2">
        <span className="label-mono border border-ink px-1.5 py-0.5">OpsPilot</span>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`label-mono border px-2 py-1 ${
                pathname.startsWith(item.href)
                  ? 'border-ink bg-ink text-paper'
                  : 'border-transparent hover:border-ink'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {memberships.length > 1 ? (
            <select
              value={organizationId ?? ''}
              onChange={(event) => {
                setOrganization(event.target.value);
              }}
              className="label-mono border border-ink bg-paper px-2 py-1"
            >
              {memberships.map((membership) => (
                <option key={membership.organizationId} value={membership.organizationId}>
                  {membership.organizationName}
                </option>
              ))}
            </select>
          ) : (
            <span className="label-mono text-ink-muted">{active?.organizationName ?? ''}</span>
          )}
          <span className="label-mono text-accent-strong">{active?.role ?? ''}</span>
          <span className="label-mono text-ink-muted">{me.data?.user.displayName}</span>
          <button
            type="button"
            onClick={() => {
              logout.mutate(undefined, {
                onSuccess: () => {
                  router.replace('/login');
                },
              });
            }}
            className="label-mono border border-ink px-2 py-1"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
