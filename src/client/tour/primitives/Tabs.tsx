import { type ReactNode, useMemo, useState } from 'react';
import { primitive } from '@/client/tour/document.js';
import type { TourTabKind } from '@/shared/tour-catalog.js';

/**
 * Two to four panes in one block's width, one shown at a time: a tab per pane with its title and,
 * when the agent gave one, a chip saying what the pane is.
 */
export function TourTabs({
  source,
  renderPane,
}: {
  source: Element;
  /** A pane's content as the article renders a card's; the same function on every render. */
  renderPane: (tab: Element) => ReactNode;
}) {
  const tabs = useMemo(
    () =>
      [...source.children].flatMap((el) => {
        const tab = primitive(el);
        return tab?.tag === 'diffle-tab' ? [{ title: tab.title, kind: tab.kind, el }] : [];
      }),
    [source],
  );
  const [shown, setShown] = useState(0);
  const pane = tabs[shown] ?? tabs[0];
  if (!pane) return null;
  return (
    <section aria-label={tabs.map((t) => t.title).join(', ')} className="tour-tabs tour-block">
      <div role="tablist" className="tour-tabs-list">
        {tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={tab === pane}
            className="tour-tab"
            onClick={() => setShown(i)}
          >
            {tab.title}
            {tab.kind && <TabChip kind={tab.kind} />}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="tour-tab-pane">
        {renderPane(pane.el)}
      </div>
    </section>
  );
}

function TabChip({ kind }: { kind: TourTabKind }) {
  return (
    <span className="tour-tab-chip" data-kind={kind}>
      {kind}
    </span>
  );
}
