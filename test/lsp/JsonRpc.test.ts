import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { JsonRpcConnection, JsonRpcError } from '../../src/server/lsp/JsonRpc.js';

it('answers asynchronous server requests and returns handler errors without losing the connection', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new JsonRpcConnection(input, output);
  const server = new JsonRpcConnection(output, input);
  client.onRequest('workspace/configuration', async () => {
    await Promise.resolve();
    return [{ hover: true }, null];
  });
  client.onRequest('fail', () => {
    throw new JsonRpcError(-32602, 'bad parameters');
  });
  expect(await server.request('workspace/configuration', {})).toEqual([{ hover: true }, null]);
  await expect(server.request('fail', {})).rejects.toMatchObject({ code: -32602 });
  expect(await server.request('window/workDoneProgress/create', {})).toBeNull();
  client.dispose(new Error('done'));
  server.dispose(new Error('done'));
});
