import { expect, test } from 'vitest';
import { protocolJsonSchema } from '../../scripts/protocol-schema.js';

// The Rust server generates its wire types from this file; `npx vitest -u` rewrites it after a protocol change.
test('the committed protocol schema matches protocol.ts', async () => {
  await expect(`${JSON.stringify(protocolJsonSchema(), null, 2)}\n`).toMatchFileSnapshot(
    '../../crates/diffle/protocol.generated.json',
  );
});
