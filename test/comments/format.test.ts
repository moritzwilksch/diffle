import { describe, expect, it } from 'vitest';
import { formatPrompt, parseSuggestions } from '../../src/server/comments/format.js';
import type { CommentMessage, CommentThread } from '../../src/shared/protocol.js';

const msg = (body: string, over: Partial<CommentMessage> = {}): CommentMessage => ({
  id: 'm',
  body,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const t = (
  over: Partial<Omit<CommentThread, 'anchor'>> & { anchor?: Partial<CommentThread['anchor']> },
): CommentThread => ({
  id: 'x',
  messages: [msg('Rename this.')],
  resolved: false,
  stale: false,
  ...over,
  anchor: {
    kind: 'line',
    path: 'src/a.py',
    side: 'new',
    startLine: 3,
    endLine: 3,
    quoted: 'def foo():',
    ...over.anchor,
  },
});

const whole = { kind: 'file', path: 'src/a.py' } as const;

describe('formatPrompt', () => {
  it('renders one block per thread in the agent format', () => {
    expect(formatPrompt([t({})])).toBe('src/a.py:3\n\n> def foo():\n\nRename this.\n\n---\n');
  });

  it('renders ranges, multi-line quotes, removed side and stale prefixes', () => {
    const out = formatPrompt([
      t({ anchor: { side: 'old', startLine: 3, endLine: 4, quoted: 'a\n\nb' } }),
      t({ stale: true, staleFromLine: 9, anchor: { path: 'src/b.py' } }),
    ]);
    expect(out).toBe(
      '(removed) src/a.py:3-4\n\n> a\n>\n> b\n\nRename this.\n\n---\n' +
        '\n(stale, was line 9) src/b.py:3\n\n> def foo():\n\nRename this.\n\n---\n',
    );
  });

  it('orders by path, then line, then creation', () => {
    const out = formatPrompt([
      t({ messages: [msg('third')], anchor: { path: 'z.py', startLine: 1, endLine: 1 } }),
      t({ messages: [msg('second')], anchor: { path: 'a.py', startLine: 9, endLine: 9 } }),
      t({ messages: [msg('first')], anchor: { path: 'a.py', startLine: 2, endLine: 2 } }),
    ]);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    expect(out.indexOf('second')).toBeLessThan(out.indexOf('third'));
  });

  it('renders a thread on the whole file with a (file) prefix and no quote, its fences as written', () => {
    const file = { ...t({ messages: [msg('Split this module.'), msg('```suggestion\nx\n```')] }), anchor: whole };
    expect(formatPrompt([file])).toBe('(file) src/a.py\n\nSplit this module.\n\n```suggestion\nx\n```\n\n---\n');
    expect(formatPrompt([{ ...file, stale: true }])).toMatch(/^\(file\) \(stale\) src\/a\.py\n/);
    // Before the file's line threads.
    expect(formatPrompt([t({}), file]).indexOf('(file)')).toBe(0);
  });

  it("joins a thread's messages with a blank line, unlabelled", () => {
    const threaded = t({ messages: [msg('Is this safe?'), msg('Never mind, the lock covers it.')] });
    expect(formatPrompt([threaded])).toBe(
      'src/a.py:3\n\n> def foo():\n\nIs this safe?\n\nNever mind, the lock covers it.\n\n---\n',
    );
  });

  it('expands suggestion fences to ORIGINAL / SUGGESTED blocks', () => {
    const body = 'Use a set:\n\n```suggestion\ndef foo() -> set[int]:\n```\n\nand update the docstring.';
    const out = formatPrompt([t({ messages: [msg(body)] })]);
    expect(out).toBe(
      'src/a.py:3\n\n> def foo():\n\nUse a set:\n\nORIGINAL:\n```\ndef foo():\n```\nSUGGESTED:\n```\ndef foo() -> set[int]:\n```\n\nand update the docstring.\n\n---\n',
    );
  });
});

describe('parseSuggestions', () => {
  it('splits prose and fences in order, keeps plain text whole, and accepts an empty suggestion', () => {
    expect(parseSuggestions('just text')).toEqual([{ text: 'just text' }]);
    expect(parseSuggestions('```suggestion\n```')).toEqual([{ text: '', code: '' }]);
    expect(parseSuggestions('a\n```suggestion\nx\ny\n```\nb\n```suggestion\nz\n```')).toEqual([
      { text: 'a\n' },
      { text: '', code: 'x\ny' },
      { text: '\nb\n' },
      { text: '', code: 'z' },
    ]);
    // A regular code fence is prose.
    expect(parseSuggestions('```python\nx\n```')).toEqual([{ text: '```python\nx\n```' }]);
  });
});

describe('a review exported as a prompt', () => {
  // One realistic export, kept as a file so a change to the format is judged by reading the prompt an
  // agent would receive rather than a string literal.
  it('reads as an agent would receive it', async () => {
    const threads: CommentThread[] = [
      {
        id: 'ledger-kind',
        anchor: {
          kind: 'line',
          path: 'tally/ledger.py',
          side: 'new',
          startLine: 3,
          endLine: 4,
          quoted: 'A line is a sale unless its ``kind`` column says ``refund``; refunds count negative.\n"""',
        },
        messages: [
          msg('Say what counts as a refund here, not only in the parser.', { id: 'a1', createdAt: 10, updatedAt: 10 }),
          msg('Also link the release notes once they mention `kind`.', { id: 'a2', createdAt: 20, updatedAt: 20 }),
        ],
        resolved: false,
        stale: false,
      },
      {
        id: 'currency-symbol',
        anchor: {
          kind: 'line',
          path: 'tally/currency.py',
          side: 'new',
          startLine: 7,
          endLine: 7,
          quoted: '_SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}',
        },
        messages: [
          msg(
            '`KWD` gets three decimals above but no symbol here.\n\n```suggestion\n_SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥", "KWD": "KD"}\n```',
            { id: 'b1', createdAt: 30, updatedAt: 30 },
          ),
        ],
        resolved: false,
        stale: false,
      },
      {
        id: 'legacy-removed',
        anchor: {
          kind: 'line',
          path: 'tally/legacy.py',
          side: 'old',
          startLine: 9,
          endLine: 15,
          quoted:
            'def read_tsv(path: Path) -> Ledger:\n    ledger = Ledger()\n    for line in path.read_text().splitlines():\n        if not line or line.startswith("#"):\n            continue\n        account, description, quantity, unit_price = line.split("\\t")\n        ledger.add(Entry(account, description, int(quantity), Decimal(unit_price)))',
        },
        messages: [
          msg('Is the archive really converted? The cron job still calls this.', {
            id: 'c1',
            createdAt: 40,
            updatedAt: 40,
          }),
        ],
        resolved: false,
        stale: false,
      },
      {
        id: 'refunds-file',
        anchor: { kind: 'file', path: 'tally/refunds.py' },
        messages: [
          msg('Consider folding this into `ledger.py`; it only has two callers.', {
            id: 'd1',
            createdAt: 50,
            updatedAt: 50,
          }),
        ],
        resolved: false,
        stale: false,
      },
      {
        id: 'cli-stale',
        anchor: {
          kind: 'line',
          path: 'tally/cli.py',
          side: 'new',
          startLine: 27,
          endLine: 27,
          quoted: 'print("no entries", file=sys.stderr)',
        },
        messages: [
          msg('Exit code 1 for "nothing to do" will trip `set -e` in the cron wrapper.', {
            id: 'e1',
            createdAt: 60,
            updatedAt: 60,
          }),
        ],
        resolved: false,
        stale: true,
        staleFromLine: 26,
      },
      {
        id: 'resolved',
        anchor: {
          kind: 'line',
          path: 'tally/ledger.py',
          side: 'new',
          startLine: 33,
          endLine: 33,
          quoted: 'amount = self.unit_price * self.quantity',
        },
        messages: [msg('Resolved threads stay out of the prompt.', { id: 'f1', createdAt: 70, updatedAt: 70 })],
        resolved: true,
        stale: false,
      },
    ];
    await expect(formatPrompt(threads.filter((t) => !t.resolved))).toMatchFileSnapshot('__snapshots__/prompt.md');
  });
});
