import { useStore } from '@/client/store.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';
import { listViews, showView, useViews, type ViewDef } from './state.js';

/** Which view takes the main pane; one that cannot be shown now names why. */
export function ViewSwitch() {
  return (
    <SegmentedControl>
      {listViews().map((view) => (
        <ViewButton key={view.id} view={view} />
      ))}
    </SegmentedControl>
  );
}

const always = () => true;

function ViewButton({ view }: { view: ViewDef }) {
  const selected = useViews((s) => s.active === view.id);
  const blocked = useStore((s) => view.blocked?.(s) ?? null);
  const listed = (view.useListed ?? always)();
  const Icon = view.icon;
  if (!listed && !selected) return null;
  return (
    <ToggleButton
      selected={selected}
      disabled={!selected && blocked != null}
      onClick={() => showView(view.id)}
      aria-label={view.label}
      title={blocked ?? view.title}
    >
      <Icon size="0.875rem" /> <span className="max-xl:hidden">{view.label}</span>
    </ToggleButton>
  );
}
