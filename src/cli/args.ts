import { InvalidArgumentError } from 'commander';

/** Commander parser for an integer in [min, max]; anything else is a usage error. */
function intArg(min: number, max: number): (raw: string) => number {
  return (raw) => {
    if (!/^\d+$/.test(raw.trim())) throw new InvalidArgumentError(`expected an integer between ${min} and ${max}`);
    const n = Number(raw);
    if (n < min || n > max) throw new InvalidArgumentError(`expected an integer between ${min} and ${max}`);
    return n;
  };
}

export const parsePort = intArg(0, 65_535);
export const parseContext = intArg(0, 10_000);
