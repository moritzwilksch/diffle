import { expect, test } from 'vitest';
import { ICON_NODES } from '@/client/tour/host/iconNodes.js';

// The server refuses a tour icon the client cannot load; `npx vitest -u` rewrites the list after a
// lucide-react upgrade.
test('the committed icon names are those the client loads', async () => {
  const names = [...ICON_NODES.keys()].sort();
  await expect(`${names.join('\n')}\n`).toMatchFileSnapshot('../../crates/diffle/lucide-icons.generated.txt');
});
