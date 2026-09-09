import { Language, Parser } from 'web-tree-sitter';
import runtime from 'web-tree-sitter/tree-sitter.wasm?url';
import { SyntaxClassifier } from './SyntaxClassifier.js';
import type { SyntaxRequest, SyntaxResponse } from './syntax.js';

const assets = import.meta.glob<string>(
  '../../../node_modules/tree-sitter-wasms/out/tree-sitter-{python,javascript,typescript,tsx,rust,go,c,cpp,ruby,java,lua,zig,swift,php,bash,ocaml}.wasm',
  { eager: true, query: '?url', import: 'default' },
);
const initialized = Parser.init({ locateFile: () => runtime });
const languages = new Map<string, Promise<Language>>();
const classifier = new SyntaxClassifier((grammar) => {
  let language = languages.get(grammar);
  if (!language) {
    language = initialized.then(() =>
      Language.load(assets[`../../../node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`]!),
    );
    languages.set(grammar, language);
  }
  return language;
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
