import type { Language } from 'web-tree-sitter';
import bindings from 'web-tree-sitter?url';
import runtime from 'web-tree-sitter/tree-sitter.wasm?url';
import lua from '@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm?url';
import { SyntaxClassifier } from './SyntaxClassifier.js';
import type { SyntaxRequest, SyntaxResponse } from './syntax.js';

const assets = import.meta.glob<string>(
  '../../../node_modules/tree-sitter-wasms/out/tree-sitter-{python,javascript,typescript,tsx,rust,go,c,cpp,ruby,java,zig,swift,php,bash,ocaml}.wasm',
  { eager: true, query: '?url', import: 'default' },
);
// Ship Emscripten's glue intact: its WASM linker uses direct eval and includes browser-inactive Node imports.
const initialized = (import(/* @vite-ignore */ bindings) as Promise<typeof import('web-tree-sitter')>).then(
  async (binding) => {
    await binding.Parser.init({ locateFile: () => runtime });
    return binding;
  },
);
const languages = new Map<string, Promise<Language>>();
const classifier = new SyntaxClassifier(async (grammar) => {
  const { Language, Parser } = await initialized;
  let language = languages.get(grammar);
  if (!language) {
    // The collection's older Lua scanner can return error trees after parsing strings.
    const url =
      grammar === 'lua' ? lua : assets[`../../../node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`]!;
    language = Language.load(url);
    languages.set(grammar, language);
  }
  const loaded = await language;
  const parser = new Parser();
  try {
    parser.setLanguage(loaded);
    return parser;
  } catch (error) {
    parser.delete();
    throw error;
  }
});

// Serialize parsing and cache replacement across asynchronous grammar loads.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<SyntaxRequest>) => {
  queue = queue.then(async () => {
    let blocked = false;
    try {
      blocked = await classifier.blocked(data.key, data.grammar, data.contents, data.line, data.col);
    } catch {
      // Missing or incompatible grammars must not disable symbol actions.
    }
    self.postMessage({ id: data.id, blocked } satisfies SyntaxResponse);
  });
};
