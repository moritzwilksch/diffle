import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../src/client/index.html', import.meta.url), 'utf8');
const redirect = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

describe('app entry URL', () => {
  it.each([
    ['https://proxy:8080/diffle', 'https://proxy:8080/diffle/'],
    ['https://proxy/review/diffle?q=1#file', 'https://proxy/review/diffle/?q=1#file'],
  ])('redirects %s to a directory before loading the app', (href, expected) => {
    const replace = vi.fn();
    runInNewContext(redirect, { URL, location: { href, replace } });
    expect(replace).toHaveBeenCalledExactlyOnceWith(expected);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link'));
  });

  it.each(['https://proxy/', 'https://proxy/diffle/', 'https://proxy/diffle/index.html?q=1#file'])(
    'does not redirect %s',
    (href) => {
      const replace = vi.fn();
      runInNewContext(redirect, { URL, location: { href, replace } });
      expect(replace).not.toHaveBeenCalled();
    },
  );
});
