// The wire contract as one JSON Schema document, for the Rust server's generated types. The JSDoc
// of `protocol.ts` rides along as `description`, which typify turns into doc comments, so the
// contract is documented once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import * as protocol from '@/shared/protocol.js';

const SOURCE = fileURLToPath(new URL('../src/shared/protocol.ts', import.meta.url));

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
  // A Windows checkout may hold CRLF; the descriptions must not depend on it.
  const docs = jsDocs(readFileSync(SOURCE, 'utf8').replaceAll('\r\n', '\n'));
  for (const [id, schema] of Object.entries(defs)) describe(schema, docs.get(`${id}Schema`), docs);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: defs };
}

type JsonSchema = {
  oneOf?: JsonSchema[];
  $ref?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  [key: string]: unknown;
};

/** What one `*Schema` declaration documents: itself, and each property of the objects it is built from. */
interface Doc {
  text?: string;
  properties: Map<string, string>;
  /** The schema a `.extend({...})` builds on, whose property docs apply too. */
  base?: string;
  /** For a discriminated union: each variant's property docs, by the `kind` it declares. */
  variants: Map<string, Map<string, string>>;
}

/** Puts the declaration's docs on `schema`: its own, its properties', and its variants'. */
function describe(schema: JsonSchema, doc: Doc | undefined, docs: Map<string, Doc>): void {
  if (!doc) return;
  if (doc.text && !schema.description) schema.description = doc.text;
  const properties = new Map<string, string>();
  for (let base = doc.base; base; base = docs.get(base)?.base) {
    for (const [name, text] of docs.get(base)?.properties ?? []) properties.set(name, text);
  }
  for (const [name, text] of doc.properties) properties.set(name, text);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const text = properties.get(name);
    if (text && !property.description) property.description = text;
  }
  for (const variant of schema.oneOf ?? []) {
    const kind = (variant.properties?.kind as { const?: string } | undefined)?.const;
    const own = kind == null ? undefined : doc.variants.get(kind);
    for (const [name, property] of Object.entries(variant.properties ?? {})) {
      const text = own?.get(name) ?? properties.get(name);
      if (text && !property.description) property.description = text;
    }
  }
}

/** The JSDoc of every exported `*Schema` declaration in `source`, as `Doc`s by declaration name. */
function jsDocs(source: string): Map<string, Doc> {
  const file = ts.createSourceFile('protocol.ts', source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Doc>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const doc: Doc = { text: comment(statement), properties: new Map(), variants: new Map() };
      collect(declaration.initializer, doc);
      out.set(declaration.name.text, doc);
    }
  }
  return out;
}

/** Walks a schema expression for `z.object({...})` and `X.extend({...})` literals and union variants. */
function collect(node: ts.Node, doc: Doc): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const [arg] = node.arguments;
    if ((method === 'object' || method === 'extend') && arg && ts.isObjectLiteralExpression(arg)) {
      for (const [name, text] of propertyDocs(arg)) doc.properties.set(name, text);
      if (method === 'extend' && ts.isIdentifier(node.expression.expression))
        doc.base = node.expression.expression.text;
    }
    if (method === 'discriminatedUnion' && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])) {
      for (const variant of node.arguments[1].elements) {
        // Every variant is a `z.object({...})` call; one shaped otherwise documents nothing.
        const object = ts.isCallExpression(variant) ? variant.arguments[0] : undefined;
        if (!object || !ts.isObjectLiteralExpression(object)) continue;
        const shape = object;
        const properties = propertyDocs(shape);
        const kind = shape.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'kind',
        );
        const value = kind && ts.isCallExpression(kind.initializer) && kind.initializer.arguments[0];
        if (value && ts.isStringLiteral(value)) doc.variants.set(value.text, properties);
      }
    }
  }
  ts.forEachChild(node, (child) => collect(child, doc));
}

function propertyDocs(literal: ts.ObjectLiteralExpression): Map<string, string> {
  const out = new Map<string, string>();
  for (const property of literal.properties) {
    const text = comment(property);
    if (text && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
      out.set(property.name.getText(), text);
  }
  return out;
}

/** The node's JSDoc text, paragraphs kept, or undefined without one. */
function comment(node: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const text = docs.map((d) => (typeof d.comment === 'string' ? d.comment : ts.getTextOfJSDocComment(d.comment)) ?? '');
  const joined = text.filter(Boolean).join('\n\n').trim();
  return joined || undefined;
}

/** typify tags a union only when it sees each variant's discriminator, so `$ref` variants are copied in. */
function inlineVariants(schema: JsonSchema, defs: Record<string, JsonSchema>): void {
  schema.oneOf = schema.oneOf?.map((variant) => (variant.$ref ? defs[variant.$ref.replace('#/$defs/', '')]! : variant));
}

function withoutKeys(schema: JsonSchema, keys: string[]): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}
