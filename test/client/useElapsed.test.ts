// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useElapsed } from '@/client/connected/clusters/useElapsed.js';

let root: Root;
let host: HTMLDivElement;
const out = { seen: 0 };

function Probe({ running }: { running: boolean }) {
  const elapsed = useElapsed(running);
  useEffect(() => {
    out.seen = elapsed;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const render = (running: boolean) => act(() => root.render(createElement(Probe, { running })));

describe('useElapsed', () => {
  it('counts the time since it started running, once a second', () => {
    render(true);
    expect(out.seen).toBe(0);
    act(() => void vi.advanceTimersByTime(1000));
    expect(out.seen).toBe(1000);
    act(() => void vi.advanceTimersByTime(4000));
    expect(out.seen).toBe(5000);
  });

  it('reads 0 again when it stops, and starts over the next time', () => {
    render(true);
    act(() => void vi.advanceTimersByTime(3000));
    render(false);
    expect(out.seen).toBe(0);
    act(() => void vi.advanceTimersByTime(5000));
    expect(out.seen).toBe(0);
    render(true);
    act(() => void vi.advanceTimersByTime(1000));
    expect(out.seen).toBe(1000);
  });

  it('leaves no timer behind when it unmounts or stops', () => {
    render(true);
    expect(vi.getTimerCount()).toBe(1);
    render(false);
    expect(vi.getTimerCount()).toBe(0);
    render(true);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });
});
