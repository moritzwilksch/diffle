import { useEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { imageKey, type Side } from '../../shared/protocol.js';
import { api } from '../api.js';
import type { ImageSides } from '../model.js';
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
 * Natural sizes by URL. A URL's key names fixed bytes, so a size never goes stale; a failed load is not
 * kept, so a remount retries it. The viewer unmounts items scrolled out of its window; a remount knows the
 * size at once and lays out at its final height.
 */
const sizes = new Map<string, Size>();

interface Decoded {
  url: string;
  size: Size;
}

/** The image at `url` once decoded: undefined while it loads, null without a url or when it does not decode. */
function useDecoded(url: string | null): Decoded | null | undefined {
  const [failed, setFailed] = useState<string | null>(null);
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
      if (live) setFailed(url);
    };
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  if (url == null || failed === url) return null;
  const size = sizes.get(url);
  return size && { url, size };
}

/** A box of `size`'s aspect ratio, as wide as it is, the pane, or the height cap allows. */
function frame({ width, height }: Size): CSSProperties {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  return { width: `min(100%, ${w}px, ${(MAX_HEIGHT_REM * w) / h}rem)`, aspectRatio: `${w} / ${h}` };
}

function caption(side: Side, image: Decoded | null | undefined): string {
  return image ? `${SIDE_LABEL[side]} · ${image.size.width} × ${image.size.height}` : SIDE_LABEL[side];
}

/**
 * A binary image's body: one side, or both next to each other or stacked so a swipe, a fade or a pixel
 * difference shows what changed. The chosen comparison applies to every image.
 */
export function ImageDiff({ path, sides }: { path: string; sides: ImageSides }) {
  const ref = useRef<HTMLDivElement>(null);
  useStandIn(ref, 'image');
  const snapshot = useStore((s) => s.snapshot);
  const urlOf = (side: Side) => {
    const key = snapshot && imageKey(snapshot, path, side);
    return key ? api.imageUrl(path, side, key) : null;
  };
  return (
    <div ref={ref} className="flex flex-col gap-2 bg-hover px-4 py-3 font-sans text-[0.8125rem]" data-image-diff>
      {sides === 'both' ? (
        <Compare path={path} url={{ old: urlOf('old'), new: urlOf('new') }} />
      ) : (
        <Single path={path} side={sides} url={urlOf(sides)} />
      )}
    </div>
  );
}

function Single({ path, side, url }: { path: string; side: Side; url: string | null }) {
  return <Figure path={path} side={side} image={useDecoded(url)} />;
}

function Compare({ path, url }: { path: string; url: Record<Side, string | null> }) {
  const compare = useStore((s) => s.imageCompare);
  const setCompare = useStore((s) => s.setImageCompare);
  const old = useDecoded(url.old);
  const next = useDecoded(url.new);
  // Stacking needs both images decoded; until then, or when one fails, the sides stand next to each other.
  const pair = old && next ? { old, new: next } : null;
  const mode = pair ? compare : 'side-by-side';
  return (
    <>
      <SegmentedControl className="self-start" role="group" aria-label="Image comparison">
        {IMAGE_COMPARES.map((c) => (
          <ToggleButton key={c} selected={mode === c} disabled={!pair} onClick={() => setCompare(c)}>
            {LABEL[c]}
          </ToggleButton>
        ))}
      </SegmentedControl>
      {pair && mode !== 'side-by-side' ? (
        <Stack mode={mode} path={path} pair={pair} />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Figure path={path} side="old" image={old} />
          <Figure path={path} side="new" image={next} />
        </div>
      )}
    </>
  );
}

function Figure({ path, side, image }: { path: string; side: Side; image: Decoded | null | undefined }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      {image === undefined ? (
        <span className="text-muted">Loading image…</span>
      ) : image === null ? (
        <span className="text-muted">Binary file: not a displayable image</span>
      ) : (
        <img
          src={image.url}
          alt={`${path} (${side})`}
          draggable={false}
          className="image-checker block"
          style={frame(image.size)}
        />
      )}
      <figcaption className="font-mono text-[0.75rem] text-muted">{caption(side, image)}</figcaption>
    </figure>
  );
}

/** Both sides on one canvas at one scale, so a pixel of one lies on the same pixel of the other. */
function Stack({
  mode,
  path,
  pair,
}: {
  mode: Exclude<ImageCompare, 'side-by-side'>;
  path: string;
  pair: Record<Side, Decoded>;
}) {
  // Swipe: how far across the old side reaches, in percent. Onion skin: the new side's opacity.
  const [amount, setAmount] = useState(50);
  const canvas = {
    width: Math.max(pair.old.size.width, pair.new.size.width),
    height: Math.max(pair.old.size.height, pair.new.size.height),
  };
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
        className={`relative isolate overflow-hidden ${mode === 'difference' ? 'bg-black' : 'image-checker'} ${mode === 'swipe' ? 'touch-none' : ''}`}
        style={frame(canvas)}
        data-stack={mode}
        onPointerMove={
          mode === 'swipe' ? (e) => e.currentTarget.hasPointerCapture(e.pointerId) && swipeTo(e) : undefined
        }
      >
        <img
          src={pair.old.url}
          alt={`${path} (old)`}
          draggable={false}
          className="absolute top-0 left-0"
          style={place(pair.old.size)}
        />
        {/* The effect sits on a canvas-sized layer: a swipe inset on a smaller image would miss the divider. */}
        <div className="absolute inset-0" style={top} data-layer="new">
          <img
            src={pair.new.url}
            alt={`${path} (new)`}
            draggable={false}
            className="absolute top-0 left-0"
            style={place(pair.new.size)}
          />
        </div>
        {mode === 'swipe' && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Swipe position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={amount}
            className="absolute inset-y-0 w-4 -translate-x-1/2 cursor-ew-resize focus-visible:outline-2 focus-visible:outline-accent"
            style={{ left: `${amount}%` }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.parentElement?.setPointerCapture(e.pointerId);
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 10 : 1;
              const value =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? 100
                    : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                      ? amount - step
                      : e.key === 'ArrowRight' || e.key === 'ArrowUp'
                        ? amount + step
                        : null;
              if (value === null) return;
              e.preventDefault();
              e.stopPropagation();
              setAmount(Math.min(100, Math.max(0, value)));
            }}
          >
            <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 font-mono text-[0.75rem] text-muted">
        <span>{caption('old', pair.old)}</span>
        {mode === 'onion' && (
          <input
            type="range"
            min={0}
            max={100}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label="New side opacity"
            className="w-40 accent-accent"
          />
        )}
        <span>{caption('new', pair.new)}</span>
        {mode === 'difference' && <span className="font-sans">Unchanged pixels are black.</span>}
      </div>
    </div>
  );
}
