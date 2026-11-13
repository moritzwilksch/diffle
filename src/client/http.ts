// Requests to the server and their answers, parsed or turned into errors; `api.ts` names the URLs.
import { z } from 'zod';
import { ApiErrorSchema } from '@/shared/protocol.js';

export function encode<S extends z.ZodType>(schema: S, value: z.input<S>): string {
  return JSON.stringify(schema.parse(value));
}

export async function json<T>(schema: z.ZodType<T>, input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(input, location.href).href, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await safeMessage(res));
  return schema.parse(res.status === 204 ? undefined : await res.json());
}

export async function text(input: string, init?: RequestInit): Promise<string> {
  const res = await fetch(new URL(input, location.href).href, init);
  if (!res.ok) throw new ApiError(res.status, await safeMessage(res));
  return res.text();
}

async function safeMessage(res: Response): Promise<string> {
  try {
    const result = ApiErrorSchema.safeParse(await res.json());
    return result.success ? result.data.error : res.statusText;
  } catch {
    return res.statusText;
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `e` is the server answering that what was asked for does not exist. */
export function isNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

export const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] != null)).toString();
