import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { expect, test } from 'vitest';

// The server refuses a tour icon the client cannot load; `npx vitest -u` rewrites the list after a
// lucide-react upgrade.
test('the committed icon names match the installed lucide-react', async () => {
  const names = Object.keys(dynamicIconImports).sort();
  await expect(`${names.join('\n')}\n`).toMatchFileSnapshot('../../crates/diffle/lucide-icons.generated.txt');
});
