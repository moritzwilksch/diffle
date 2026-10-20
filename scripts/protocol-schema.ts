// The wire contract as one JSON Schema document, for the Rust server's generated types.
import { z } from 'zod';
import * as protocol from '@/shared/protocol.js';

/** Every `*Schema` export of `protocol.ts` under `$defs`, named without the suffix; request schemas as the client sends them. */
export function protocolJsonSchema(): object {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(protocol)) {
    if (name.endsWith('Schema') && schema instanceof z.ZodType)
      registry.add(schema, { id: name.slice(0, -'Schema'.length) });
  }
  const { schemas } = z.toJSONSchema(registry, { io: 'input', unrepresentable: 'any', uri: (id) => `#/$defs/${id}` });
  const defs: Record<string, JsonSchema> = Object.fromEntries(
    Object.entries(schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, schema]) => [id, withoutKeys(schema as JsonSchema, ['$schema', '$id'])]),
  );
  for (const schema of Object.values(defs)) inlineVariants(schema, defs);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: defs };
}

type JsonSchema = { oneOf?: JsonSchema[]; $ref?: string; [key: string]: unknown };

/** typify tags a union only when it sees each variant's discriminator, so `$ref` variants are copied in. */
function inlineVariants(schema: JsonSchema, defs: Record<string, JsonSchema>): void {
  schema.oneOf = schema.oneOf?.map((variant) => (variant.$ref ? defs[variant.$ref.replace('#/$defs/', '')]! : variant));
}

function withoutKeys(schema: JsonSchema, keys: string[]): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}
