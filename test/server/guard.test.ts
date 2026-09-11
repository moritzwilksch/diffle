import { describe, expect, it } from 'vitest';
import { requestGuard } from '../../src/server/guard.js';

describe('requestGuard', () => {
  const loop = requestGuard('127.0.0.1');
  const open = requestGuard('0.0.0.0', ['mybox', 'mybox.local']);

  it('accepts loopback hosts on a loopback bind, with or without a matching Origin', () => {
    expect(loop({ host: '127.0.0.1:4966' })).toBe(true);
    expect(loop({ host: 'localhost:4966' })).toBe(true);
    expect(loop({ host: '[::1]:4966' })).toBe(true);
    expect(loop({ host: 'localhost:4966', origin: 'http://localhost:4966' })).toBe(true);
  });

  it('rejects DNS-rebinding hosts on a loopback bind', () => {
    expect(loop({ host: 'evil.example:4966' })).toBe(false);
    expect(loop({ host: '10.0.0.5:4966' })).toBe(false);
    expect(loop({})).toBe(false);
  });

  it('rejects an Origin that does not match Host on any bind', () => {
    expect(loop({ host: 'localhost:4966', origin: 'http://evil.example' })).toBe(false);
    expect(loop({ host: 'localhost:4966', origin: 'http://localhost:5000' })).toBe(false);
    expect(loop({ host: 'localhost:4966', origin: 'null' })).toBe(false);
    expect(open({ host: '192.168.1.2:4966', origin: 'http://evil.example' })).toBe(false);
  });

  it("accepts IP literals, loopback and the machine's own names on a non-loopback bind", () => {
    expect(open({ host: '192.168.1.2:4966' })).toBe(true);
    expect(open({ host: '192.168.1.2:4966', origin: 'http://192.168.1.2:4966' })).toBe(true);
    expect(open({ host: '[fe80::1]:4966' })).toBe(true);
    expect(open({ host: 'localhost:4966' })).toBe(true);
    expect(open({ host: 'MyBox.local:4966' })).toBe(true);
  });

  it('rejects DNS-rebinding hosts on a non-loopback bind', () => {
    expect(open({ host: 'evil.example:4966' })).toBe(false);
    expect(open({ host: 'evil.example:4966', origin: 'http://evil.example:4966' })).toBe(false);
  });

  it('accepts a hostname bind as its own Host', () => {
    const named = requestGuard('mybox.example', []);
    expect(named({ host: 'mybox.example:4966' })).toBe(true);
    expect(named({ host: 'other.example:4966' })).toBe(false);
  });
});

describe('reverse proxy origin', () => {
  const origin = 'https://proxy.example:8443';
  it.each(['127.0.0.1', '0.0.0.0'])('accepts public or upstream Host on %s', (bind) => {
    const guard = requestGuard(bind, [], origin);
    for (const host of ['proxy.example:8443', '127.0.0.1:4966']) {
      expect(guard({ host })).toBe(true);
      expect(guard({ host, origin })).toBe(true);
      for (const foreign of ['https://evil.example', 'null', 'http://proxy.example:8443', 'https://proxy.example']) {
        expect(guard({ host, origin: foreign })).toBe(false);
      }
    }
    expect(guard({ host: 'evil.example', origin })).toBe(false);
    expect(guard({ host: 'proxy.example:8444', origin })).toBe(false);
    expect(guard({ origin })).toBe(false);
    expect(guard({ host: '127.0.0.1:4966', origin: 'http://127.0.0.1:4966' })).toBe(true);
  });
});
