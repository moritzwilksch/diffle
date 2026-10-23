// The wire contract as one JSON Schema document, for the Rust server's generated types. The JSDoc
// of `protocol.ts` rides along as `description`, which typify turns into doc comments, so the
// contract is documented once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Comment,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSync,
  visitorKeys,
} from 'oxc-parser';
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

/** The JSDoc of every `*Schema` declaration in `source`, as `Doc`s by declaration name. */
function jsDocs(source: string): Map<string, Doc> {
  const { program, comments } = parseSync('protocol.ts', source, { lang: 'ts', sourceType: 'module' });
  const docOf = jsDocReader(source, comments);
  const out = new Map<string, Doc>();
  for (const statement of program.body) {
    const declarations =
      statement.type === 'VariableDeclaration'
        ? statement
        : statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration'
          ? statement.declaration
          : undefined;
    for (const declaration of declarations?.declarations ?? []) {
      if (declaration.id.type !== 'Identifier' || !declaration.init) continue;
      const doc: Doc = { text: docOf(statement), properties: new Map(), variants: new Map() };
      collect(declaration.init, doc, docOf);
      out.set(declaration.id.name, doc);
    }
  }
  return out;
}

type DocOf = (node: Node) => string | undefined;

/** Walks a schema expression for `z.object({...})` and `X.extend({...})` literals and union variants. */
function collect(node: Node, doc: Doc, docOf: DocOf): void {
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
    const method = node.callee.property.name;
    const [arg, variants] = node.arguments;
    if ((method === 'object' || method === 'extend') && arg?.type === 'ObjectExpression') {
      for (const [name, text] of propertyDocs(arg, docOf)) doc.properties.set(name, text);
      if (method === 'extend' && node.callee.object.type === 'Identifier') doc.base = node.callee.object.name;
    }
    if (method === 'discriminatedUnion' && variants?.type === 'ArrayExpression') {
      for (const variant of variants.elements) {
        // Every variant is a `z.object({...})` call; one shaped otherwise documents nothing.
        const shape = variant?.type === 'CallExpression' ? variant.arguments[0] : undefined;
        if (shape?.type !== 'ObjectExpression') continue;
        const kind = shape.properties.find((p) => p.type === 'Property' && keyName(p) === 'kind');
        const value = kind?.type === 'Property' && kind.value.type === 'CallExpression' && kind.value.arguments[0];
        if (value && value.type === 'Literal' && typeof value.value === 'string')
          doc.variants.set(value.value, propertyDocs(shape, docOf));
      }
    }
  }
  for (const key of visitorKeys[node.type] ?? []) {
    const child: unknown = (node as unknown as Record<string, unknown>)[key];
    for (const c of Array.isArray(child) ? child : [child]) if (isNode(c)) collect(c, doc, docOf);
  }
}

function propertyDocs(literal: ObjectExpression, docOf: DocOf): Map<string, string> {
  const out = new Map<string, string>();
  for (const property of literal.properties) {
    if (property.type !== 'Property') continue;
    const name = keyName(property);
    const text = docOf(property);
    if (name && text) out.set(name, text);
  }
  return out;
}

function keyName(property: ObjectProperty): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === 'Identifier') return property.key.name;
  return property.key.type === 'Literal' ? String(property.key.value) : undefined;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Reads the `/** ... *\/` blocks right before a node, paragraphs kept and tags dropped, or undefined without one. */
function jsDocReader(source: string, comments: Comment[]): DocOf {
  return (node) => {
    const blocks: string[] = [];
    let at = node.start;
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!;
      if (c.end > at) continue;
      if (c.type !== 'Block' || !c.value.startsWith('*') || source.slice(c.end, at).trim()) break;
      blocks.unshift(jsDocText(c.value.slice(1)));
      at = c.start;
    }
    const joined = blocks.filter(Boolean).join('\n\n').trim();
    return joined || undefined;
  };
}

/** A JSDoc body without its `*` margins, up to its first tag. */
function jsDocText(body: string): string {
  const lines = body.split('\n').map((line) => line.replace(/^\s*\*? ?/, '').trimEnd());
  const tag = lines.findIndex((line) => line.startsWith('@'));
  return (tag < 0 ? lines : lines.slice(0, tag)).join('\n').trim();
}

/** typify tags a union only when it sees each variant's discriminator, so `$ref` variants are copied in. */
function inlineVariants(schema: JsonSchema, defs: Record<string, JsonSchema>): void {
  schema.oneOf = schema.oneOf?.map((variant) => (variant.$ref ? defs[variant.$ref.replace('#/$defs/', '')]! : variant));
}

function withoutKeys(schema: JsonSchema, keys: string[]): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}
