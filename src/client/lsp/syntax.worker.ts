import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { SyntaxClassifier } from './SyntaxClassifier.js';
import type { SyntaxRequest, SyntaxResponse } from './syntax.js';

// The viewer's engine: no Oniguruma WASM, and the same grammars resolve the same scopes.
const highlighter = await createHighlighterCore({ engine: createJavaScriptRegexEngine() });
const classifier = new SyntaxClassifier((lang) => highlighter.getLanguage(lang));

self.onmessage = async ({ data }: MessageEvent<SyntaxRequest>) => {
  let blocked = false;
  try {
    // Grammars ride along with a language's first request; later requests queue behind it.
    if (data.grammars) highlighter.loadLanguageSync(data.grammars);
    blocked = await classifier.blocked(data.key, data.lang, data.contents, data.line, data.col);
  } catch {
    // Missing or incompatible grammars must not disable symbol actions.
  }
  self.postMessage({ id: data.id, blocked } satisfies SyntaxResponse);
};
