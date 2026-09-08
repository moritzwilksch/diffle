import { describe, expect, it } from 'vitest';
import { parseContext, parsePort } from '../../src/cli/args.js';

describe('CLI numeric arguments', () => {
  it('accepts integers in range', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('65535')).toBe(65535);
    expect(parseContext('12')).toBe(12);
  });

  it('rejects non-integers and out-of-range values as usage errors', () => {
    for (const bad of ['nope', '', '1.5', '-1', '65536']) expect(() => parsePort(bad)).toThrow(/integer between 0 and 65535/);
    expect(() => parseContext('10001')).toThrow(/integer between 0 and 10000/);
  });
});
