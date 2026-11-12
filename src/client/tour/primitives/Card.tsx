import type { ReactNode } from 'react';
import { TourIcon } from './Icon.js';

/** A framed explainer for one part of the diff: its title, after its icon, over its prose and the diffs it explains. */
export function TourCard({
  id,
  title,
  icon,
  children,
}: {
  id: string;
  title: string;
  icon?: string;
  children: ReactNode;
}) {
  return (
    <section data-card={id} aria-label={title} className="tour-card">
      <h4 className="tour-card-title">
        {icon && <TourIcon name={icon} />}
        {title}
      </h4>
      <div className="tour-card-body">{children}</div>
    </section>
  );
}
