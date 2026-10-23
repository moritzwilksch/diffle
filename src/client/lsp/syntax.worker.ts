import { SyntaxClassifier } from './SyntaxClassifier.js';
import type { SyntaxRequest, SyntaxResponse } from './syntax.js';

const classifier = new SyntaxClassifier();

self.onmessage = ({ data }: MessageEvent<SyntaxRequest>) => {
  let blocked = false;
  try {
    blocked = classifier.blocked(data.key, data.lang, data.contents, data.line, data.col);
  } catch {
    // A lexer failure must not disable symbol actions.
  }
  self.postMessage({ id: data.id, blocked } satisfies SyntaxResponse);
};
