import Link from 'next/link';
import { type ReactNode } from 'react';

/** Small monospace label that opens a section, as on both reference sites. */
export function Eyebrow({ children, tone = 'lilac' }: { children: ReactNode; tone?: string }) {
  return <p className={`label-mono text-${tone}`}>{children}</p>;
}

export function Section({
  children,
  className = '',
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`border-t border-night-line px-6 py-20 md:py-28 ${className}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 border border-paper bg-paper px-5 py-2.5 text-ink transition-opacity hover:opacity-85"
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  );
}

export function GhostLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 border border-night-line px-5 py-2.5 text-paper transition-colors hover:border-paper"
    >
      {children}
    </Link>
  );
}

/**
 * The window frame from the product UI, reused here so the landing page and
 * the application look like the same piece of software.
 */
export function DarkWindow({
  title,
  meta,
  children,
  className = '',
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col border border-night-line bg-night-soft ${className}`}>
      <div className="flex items-baseline justify-between gap-4 border-b border-night-line bg-paper px-3 py-1.5 text-ink">
        <span className="label-mono">{title}</span>
        {meta ? <span className="label-mono opacity-60">{meta}</span> : null}
      </div>
      <div className="flex-1 p-5">{children}</div>
    </div>
  );
}
