import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyntaxRequest, SyntaxResponse } from '../../src/client/lsp/syntax.js';

class WorkerStub {
  static instance: WorkerStub;
  onmessage?: (event: { data: SyntaxResponse }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  postMessage = vi.fn<(data: SyntaxRequest) => void>();
  terminate = vi.fn();
  constructor() {
    WorkerStub.instance = this;
  }
  answer(index: number, blocked: boolean): void {
    this.onmessage?.({ data: { id: this.postMessage.mock.calls[index]![0].id, blocked } });
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('Worker', WorkerStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('loads contents only for supported languages and routes out-of-order answers', async () => {
  const { blocksSymbol } = await import('../../src/client/lsp/syntax.js');
  const contents = vi.fn().mockResolvedValue('# comment');
  expect(await blocksSymbol('a.nix', 'new', 1, 2, contents)).toBe(false);
  expect(contents).not.toHaveBeenCalled();
  const first = blocksSymbol('a.py', 'old', 1, 2, contents);
  const second = blocksSymbol('a.py', 'new', 1, 2, contents);
  await Promise.resolve();
  const worker = WorkerStub.instance;
  expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({
    key: 'old:a.py',
    grammar: 'python',
    contents: '# comment',
    line: 1,
    col: 2,
  });
  worker.answer(1, false);
  worker.answer(0, true);
  expect(await first).toBe(true);
  expect(await second).toBe(false);
});

it('fails open on missing contents or oversized files', async () => {
  const { blocksSymbol } = await import('../../src/client/lsp/syntax.js');
  expect(
    await blocksSymbol('a.py', 'new', 1, 0, async () => {
      throw new Error('gone');
    }),
  ).toBe(false);
  expect(await blocksSymbol('a.py', 'new', 1, 0, async () => '#'.repeat(1_000_001))).toBe(false);
});

it.each(['error', 'timeout'])('releases pending requests after a worker %s', async (failure) => {
  vi.useFakeTimers();
  const { blocksSymbol } = await import('../../src/client/lsp/syntax.js');
  const result = blocksSymbol('a.py', 'new', 1, 2, async () => '# comment');
  await Promise.resolve();
  const worker = WorkerStub.instance;
  if (failure === 'error') worker.onerror!();
  else await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe(false);
  expect(worker.terminate).toHaveBeenCalledOnce();
  const contents = vi.fn();
  expect(await blocksSymbol('a.py', 'new', 1, 2, contents)).toBe(false);
  expect(contents).not.toHaveBeenCalled();
});
