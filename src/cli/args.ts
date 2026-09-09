import { InvalidArgumentError } from 'commander';
import { LANGUAGE_IDS, type LanguageId } from '../shared/protocol.js';

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

/** Commander parser for a language diffle knows; anything else lists the ones it does. */
export function parseLanguage(raw: string): LanguageId {
  const language = raw.trim().toLowerCase();
  if (!(LANGUAGE_IDS as string[]).includes(language))
    throw new InvalidArgumentError(`unknown language "${raw}"; expected one of: ${LANGUAGE_IDS.join(', ')}`);
  return language as LanguageId;
}

/**
 * Commander parser for a variadic `<language...>`. It folds the parser over the values, so
 * this appends: handed `parseLanguage` itself, the command would receive only the last one.
 */
export function collectLanguage(raw: string, prev: LanguageId[] = []): LanguageId[] {
  return [...prev, parseLanguage(raw)];
}

/** A `--lsp` value: which language to serve with which command. */
export interface LspOverride {
  language: LanguageId;
  command: string;
}

/**
 * A `--lsp <language>=<command>` value. The language must be one diffle knows, or the pair
 * reads as a command with an `=` in it and would silently serve nothing.
 */
export function parseLspOverride(raw: string): LspOverride {
  const eq = raw.indexOf('=');
  if (eq === -1)
    throw new InvalidArgumentError(`expected <language>=<command>, e.g. --lsp python="pyrefly lsp" (got "${raw}")`);
  return { language: parseLanguage(raw.slice(0, eq)), command: raw.slice(eq + 1).trim() };
}

/** Repeated `--lsp`, in the order given; `prev` is the option's default until the first one. */
export function collectLspOverride(raw: string, prev: boolean | LspOverride[]): LspOverride[] {
  return [...(Array.isArray(prev) ? prev : []), parseLspOverride(raw)];
}
