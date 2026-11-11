import type { ReactNode } from 'react';

/** A framed explainer for one part of the diff: its title over its prose and the diffs it explains. */
export function TourCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-card={id} aria-label={title} className="tour-card">
      <h4 className="tour-card-title">{title}</h4>
      <div className="tour-card-body">{children}</div>
    </section>
  );
}
