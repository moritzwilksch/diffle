import { useEffect, useState } from 'react';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { nodeKey, nodePath, placeOf } from '@/client/tour/anchor.js';
import { primitive } from '@/client/tour/document.js';
import type { CheckProps } from './host.js';

/**
 * Questions the reviewer decides: each item ticks as decided, or takes an answer, a thread on the
 * item the agent reads with the prompt and `diffle comments list`. The server pairs each item with
 * its tick and answer, read with the threads; until it has, an item cannot be ticked.
 */
export function LiveCheck({ source, renderItem }: CheckProps) {
  const checks = useStore((s) => s.checks);
  // A tick shows at once and holds until the tour read back agrees, or the tick fails.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  const ticked = (question: string, stored: boolean) => pending.get(question) ?? stored;
  const settle = (keep: (question: string, on: boolean) => boolean) =>
    setPending((prev) => {
      const next = new Map([...prev].filter(([question, on]) => keep(question, on)));
      return next.size === prev.size ? prev : next;
    });
  useEffect(() => settle((question, on) => checks.find((c) => c.question === question)?.ticked !== on), [checks]);
  const onTick = (question: string, on: boolean) => {
    setPending((prev) => new Map(prev).set(question, on));
    void tick(question, on).then((done) => done || settle((q) => q !== question));
  };
  const items = [...source.children].flatMap((el) => {
    const item = primitive(el);
    if (item?.tag !== 'diffle-item') return [];
    const key = nodeKey(nodePath(el));
    const check = checks.find((c) => nodeKey(c.node) === key);
    return [{ el, key, context: item.context, check, answer: check?.thread }];
  });
  const decided = items.filter((i) => i.check && ticked(i.check.question, i.check.ticked)).length;
  return (
    <section {...placeOf(source)} aria-label="Checklist" className="tour-check tour-block">
      <div data-opaque="" className="tour-check-head">
        {decided} of {items.length} decided
      </div>
      <ul className="tour-check-items">
        {items.map(({ el, key, context, check, answer }) => (
          <li
            key={key}
            {...placeOf(el)}
            data-ticked={(check && ticked(check.question, check.ticked)) || undefined}
            className="tour-check-item"
          >
            <input
              type="checkbox"
              data-opaque=""
              checked={check ? ticked(check.question, check.ticked) : false}
              disabled={!check}
              aria-label={check ? `Decided: ${check.question}` : 'Decided'}
              onChange={(e) => check && onTick(check.question, e.target.checked)}
            />
            <div className="min-w-0">
              <div className="tour-check-question">{renderItem(el)}</div>
              {context && (
                <div data-opaque="" className="tour-check-context">
                  {context}
                </div>
              )}
            </div>
            <Button
              data-opaque=""
              variant="ghost"
              className="text-[0.75rem]"
              onClick={() =>
                answer
                  ? useStore.getState().focusThread(answer)
                  : useStore.getState().openTourDraft(nodePath(el), { on: 'element' })
              }
            >
              {answer ? 'Show answer' : 'Answer'}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Stores a tick and reads the items back; false when it could not be stored. */
async function tick(question: string, ticked: boolean): Promise<boolean> {
  try {
    await api.tick({ question, ticked });
  } catch (e) {
    useStore.getState().flash(`Cannot tick it: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  await useStore.getState().refreshThreads();
  return true;
}
