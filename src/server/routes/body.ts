import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** Invalid JSON is a request error; failures after parsing still propagate. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
}
