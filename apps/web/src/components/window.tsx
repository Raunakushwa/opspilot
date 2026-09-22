import { type ReactNode } from 'react';

export interface WindowProps {
  title: string;
  /** Short right-aligned metadata in the title bar, e.g. a timestamp or count. */
  meta?: string;
  children: ReactNode;
  className?: string;
}

/**
 * The primitive every panel is built from: a framed window with a black title
 * bar. Incident timeline, AI investigation, tool activity and approval requests
 * all render inside one of these.
 */
export function Window({ title, meta, children, className = '' }: WindowProps) {
  return (
    <section className={`flex flex-col border border-ink bg-panel ${className}`}>
      <header className="flex items-baseline justify-between gap-4 border-b border-ink bg-ink px-2 py-1 text-paper">
        <h2 className="label-mono">{title}</h2>
        {meta ? <span className="label-mono text-panel-edge">{meta}</span> : null}
      </header>
      <div className="flex-1 bg-paper p-4">{children}</div>
    </section>
  );
}
