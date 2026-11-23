import { Minus } from 'lucide-react';
import type { MouseEvent } from 'react';
import { Button } from '@/client/ui/Button.js';

export function collapseFromCardClick(event: MouseEvent<HTMLElement>, collapse: () => void): void {
  const target = event.target;
  if (event.defaultPrevented || !(target instanceof Element) || !event.currentTarget.contains(target)) return;
  if (target.closest('a, button, input, select, textarea, label, summary, [role="button"], [contenteditable]')) return;
  if (window.getSelection()?.isCollapsed !== false) collapse();
}

export function InlineThreadCollapse({ label, onCollapse }: { label: string; onCollapse: () => void }) {
  return (
    <Button variant="ghost" icon aria-label={label} title={label} onClick={onCollapse}>
      <Minus size="0.75rem" />
    </Button>
  );
}
