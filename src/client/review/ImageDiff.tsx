import { useEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Side } from '../../shared/protocol.js';
import { api } from '../api.js';
import { imageKey } from '../model.js';
import { useStore, type ImageCompare, IMAGE_COMPARES } from '../store.js';
import { SegmentedControl, ToggleButton } from '../ui/ToggleButton.js';
import { useStandIn } from './PlaceholderBanner.js';

interface Size {
  width: number;
  height: number;
}

/** Tallest an image is drawn, in rem: a tall screenshot must not push the rest of the review a page down. */
const MAX_HEIGHT_REM = 32;

const LABEL: Record<ImageCompare, string> = {
  'side-by-side': 'Side by side',
  swipe: 'Swipe',
  onion: 'Onion skin',
  difference: 'Difference',
};

const SIDE_LABEL: Record<Side, string> = { old: 'Old', new: 'New' };

/**
 * Natural sizes by URL, null for bytes that do not decode. The viewer unmounts items scrolled out of
 * its window; a remount knows the size at once and lays out at its final height.
 */
const sizes = new Map<string, Size | null>();

/** The natural size of the image at `url`: undefined while it loads (or without a url), null when it does not decode. */
function useImageSize(url: string | null): Size | null | undefined {
  const [, loaded] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (url == null || sizes.has(url)) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      sizes.set(url, { width: img.naturalWidth, height: img.naturalHeight });
      if (live) loaded();
    };
    img.onerror = () => {
      sizes.set(url, null);
      if (live) loaded();
    };
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return url == null ? undefined : sizes.get(url);
}

/** A box of `size`'s aspect ratio, as wide as it is, the pane, or the height cap allows. */
function frame({ width, height }: Size): CSSProperties {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  return { width: `min(100%, ${w}px, ${(MAX_HEIGHT_REM * w) / h}rem)`, aspectRatio: `${w} / ${h}` };
}

function caption(side: Side, size: Size | null | undefined): string {
  return size ? `${SIDE_LABEL[side]} · ${size.width} × ${size.height}` : SIDE_LABEL[side];
}

/**
 * A binary image's body: its sides next to each other, or, with both sides present, stacked so a swipe,
 * a fade or a pixel difference shows what changed. The chosen comparison applies to every image.
 */
export function ImageDiff({ path, sides }: { path: string; sides: Side[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useStandIn(ref, 'image');
  const snapshot = useStore((s) => s.snapshot);
  const compare = useStore((s) => s.imageCompare);
  const setCompare = useStore((s) => s.setImageCompare);
  const urlOf = (side: Side) =>
    snapshot && sides.includes(side) ? api.imageUrl(path, side, imageKey(snapshot, path, side)) : null;
  const url: Record<Side, string | null> = { old: urlOf('old'), new: urlOf('new') };
  const oldSize = useImageSize(url.old);
  const newSize = useImageSize(url.new);
  const size: Record<Side, Size | null | undefined> = { old: oldSize, new: newSize };
  // Stacking needs both images decoded; until then, or when one fails, the sides stand next to each other.
  const both = sides.length === 2 && oldSize != null && newSize != null;
  const mode = both ? compare : 'side-by-side';
  return (
    <div ref={ref} className="flex flex-col gap-2 bg-hover px-4 py-3 font-sans text-[0.8125rem]" data-image-diff>
      {sides.length === 2 && (
        <SegmentedControl className="self-start" role="group" aria-label="Image comparison">
          {IMAGE_COMPARES.map((c) => (
            <ToggleButton key={c} selected={mode === c} disabled={!both} onClick={() => setCompare(c)}>
              {LABEL[c]}
            </ToggleButton>
          ))}
        </SegmentedControl>
      )}
      {mode === 'side-by-side' ? (
        <div className={`grid gap-4 ${sides.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {sides.map((side) => (
            <figure key={side} className="m-0 flex min-w-0 flex-col gap-1">
              <figcaption className="font-mono text-[0.75rem] text-muted">{caption(side, size[side])}</figcaption>
              <SideImage url={url[side]} size={size[side]} alt={`${path} (${side})`} />
            </figure>
          ))}
        </div>
      ) : (
        <Stack mode={mode} path={path} oldUrl={url.old!} newUrl={url.new!} oldSize={oldSize!} newSize={newSize!} />
      )}
    </div>
  );
}

function SideImage({ url, size, alt }: { url: string | null; size: Size | null | undefined; alt: string }) {
  if (url == null || size === undefined) return <span className="text-muted">Loading image…</span>;
  if (size === null) return <span className="text-muted">Binary file: not a displayable image</span>;
  return <img src={url} alt={alt} draggable={false} className="image-checker block" style={frame(size)} />;
}

/** Both sides on one canvas at one scale, so a pixel of one lies on the same pixel of the other. */
function Stack({
  mode,
  path,
  oldUrl,
  newUrl,
  oldSize,
  newSize,
}: {
  mode: Exclude<ImageCompare, 'side-by-side'>;
  path: string;
  oldUrl: string;
  newUrl: string;
  oldSize: Size;
  newSize: Size;
}) {
  // Swipe: how far across the old side reaches, in percent. Onion skin: the new side's opacity.
  const [amount, setAmount] = useState(50);
  const canvas = { width: Math.max(oldSize.width, newSize.width), height: Math.max(oldSize.height, newSize.height) };
  const place = (s: Size): CSSProperties => ({
    width: `${(s.width / canvas.width) * 100}%`,
    height: `${(s.height / canvas.height) * 100}%`,
  });
  const swipeTo = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) setAmount(Math.round(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * 100));
  };
  const top: CSSProperties =
    mode === 'swipe'
      ? { clipPath: `inset(0 0 0 ${amount}%)` }
      : mode === 'onion'
        ? { opacity: amount / 100 }
        : { mixBlendMode: 'difference' };
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`relative isolate overflow-hidden ${mode === 'difference' ? 'bg-black' : 'image-checker'} ${mode === 'swipe' ? 'cursor-ew-resize touch-none' : ''}`}
        style={frame(canvas)}
        data-stack={mode}
        onPointerDown={
          mode === 'swipe'
            ? (e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                swipeTo(e);
              }
            : undefined
        }
        onPointerMove={mode === 'swipe' ? (e) => e.buttons & 1 && swipeTo(e) : undefined}
      >
        <img
          src={oldUrl}
          alt={`${path} (old)`}
          draggable={false}
          className="absolute top-0 left-0"
          style={place(oldSize)}
        />
        <img
          src={newUrl}
          alt={`${path} (new)`}
          draggable={false}
          className="absolute top-0 left-0"
          style={{ ...place(newSize), ...top }}
        />
        {mode === 'swipe' && (
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent" style={{ left: `${amount}%` }} />
        )}
      </div>
      <div className="flex items-center gap-3 font-mono text-[0.75rem] text-muted">
        <span>{caption('old', oldSize)}</span>
        {mode !== 'difference' && (
          <input
            type="range"
            min={0}
            max={100}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label={mode === 'swipe' ? 'Swipe position' : 'New side opacity'}
            className="w-40 accent-accent"
          />
        )}
        <span>{caption('new', newSize)}</span>
        {mode === 'difference' && <span className="font-sans">Unchanged pixels are black.</span>}
      </div>
    </div>
  );
}
