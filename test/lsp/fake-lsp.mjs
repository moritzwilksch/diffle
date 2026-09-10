// Minimal stdio language server for tests: answers initialize, definition, references,
// documentSymbol, workspace/symbol, hover, semanticTokens/range, shutdown. Definitions point at line 2 of the queried
// file plus one location outside the root; references echo the open document's text length.
import { pathToFileURL } from 'node:url';

let buf = Buffer.alloc(0);
const docs = new Map();
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    handle(msg);
  }
});

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const log = (line) => process.stderr.write(line + '\n');
// FAKE_LSP_EXTERNAL: the file outside the root definitions also point at; tests set it to a real file.
const EXTERNAL = process.env.FAKE_LSP_EXTERNAL ?? '/usr/lib/python3/site.py';
const base = (uri) => uri.replace(/^.*\//, '');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const range = (line, ch = 0) => ({ start: { line, character: ch }, end: { line, character: ch + 1 } });
const span = (startLine, endLine, ch = 0) => ({
  start: { line: startLine, character: ch },
  end: { line: endLine, character: 0 },
});

/** FAKE_LSP_MODIFIED: refuse this many document requests with ContentModified before answering. */
let modified = Number(process.env.FAKE_LSP_MODIFIED ?? 0);

function handle(msg) {
  if (modified > 0 && msg.id != null && msg.method?.startsWith('textDocument/')) {
    modified--;
    log(`refused ${msg.method}`);
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32801, message: 'content modified' } });
  }
  if (msg.id === 'config') return log(`config ${JSON.stringify(msg.result)}`);
  switch (msg.method) {
    case 'initialize':
      if (process.env.FAKE_LSP_DIE === '1') process.exit(3);
      if (process.env.FAKE_LSP_CONFIG === '1')
        log(`protocols ${msg.params.initializationOptions.handledSchemaProtocols.join(',')}`);
      return reply(msg.id, { capabilities: {} });
    case 'workspace/didChangeConfiguration':
      if (process.env.FAKE_LSP_CONFIG === '1')
        send({
          jsonrpc: '2.0',
          id: 'config',
          method: 'workspace/configuration',
          params: { items: [{ section: 'json' }, { section: 'unknown' }] },
        });
      return;
    // Document lifecycle goes to stderr so tests can observe what the bridge opened.
    case 'textDocument/didOpen':
      docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
      // FAKE_LSP_INDEX mimics pyrefly's indexing log lines, split across writes like a real stderr stream.
      if (process.env.FAKE_LSP_INDEX === '1' && docs.size === 1) {
        log(' INFO Populating up to 2000 files in the workspace ("/repo").');
        setTimeout(() => process.stderr.write(' INFO Populated all files in the '), 20);
        setTimeout(() => log('workspace, prepare to recheck open files.'), 40);
      }
      return log(`open ${base(msg.params.textDocument.uri)} v${msg.params.textDocument.version}`);
    case 'textDocument/didChange':
      docs.set(msg.params.textDocument.uri, msg.params.contentChanges[0].text);
      return log(`change ${base(msg.params.textDocument.uri)} v${msg.params.textDocument.version}`);
    case 'textDocument/didClose':
      docs.delete(msg.params.textDocument.uri);
      return log(`close ${base(msg.params.textDocument.uri)}`);
    case 'textDocument/definition': {
      // FAKE_LSP_REAL_ROOT mimics a server that canonicalizes symlinked roots.
      const uri = process.env.FAKE_LSP_REAL_ROOT
        ? msg.params.textDocument.uri.replace(
            pathToFileURL(process.env.FAKE_LSP_ROOT).href,
            pathToFileURL(process.env.FAKE_LSP_REAL_ROOT).href,
          )
        : msg.params.textDocument.uri;
      return reply(msg.id, [
        { uri, range: range(1, 4) },
        { uri: pathToFileURL(EXTERNAL).href, range: range(0) },
      ]);
    }
    case 'textDocument/references': {
      const text = docs.get(msg.params.textDocument.uri) ?? '';
      return reply(msg.id, [
        { uri: msg.params.textDocument.uri, range: range(0, text.length) },
        { uri: msg.params.textDocument.uri.replace(/[^/]+$/, 'other.py'), range: range(2) },
        { uri: msg.params.textDocument.uri.replace(/[^/]+$/, 'ignored.py'), range: range(0) },
      ]);
    }
    case 'textDocument/hover':
      // Empty text at line 1: nothing to say. Elsewhere: markdown plus a legacy language block.
      if (msg.params.position.line === 0) return reply(msg.id, null);
      // FAKE_LSP_HOVER_LINKS mimics pyright's "Go to X" links: one inside the root, one outside it.
      if (process.env.FAKE_LSP_HOVER_LINKS === '1')
        return reply(msg.id, {
          contents: {
            kind: 'markdown',
            value: `Go to [f](${msg.params.textDocument.uri}#3,4) or [site](${pathToFileURL('/usr/lib/python3/site.py').href}#10,2)`,
          },
        });
      return reply(msg.id, {
        contents: [{ language: 'python', value: 'def f() -> None' }, 'Does the `f` thing.'],
        range: range(msg.params.position.line, 4),
      });
    case 'textDocument/semanticTokens/range': {
      // FAKE_LSP_NO_TOKENS mimics a server without semantic tokens (open-source pyright).
      if (process.env.FAKE_LSP_NO_TOKENS === '1')
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      // Every word of the requested line, relative-encoded; `if`/`else`/`import`/`pass` are keywords (15), the rest variables (8).
      const text = docs.get(msg.params.textDocument.uri) ?? '';
      const lineNo = msg.params.range.start.line;
      const line = text.split('\n')[lineNo] ?? '';
      const data = [];
      let prevLine = 0;
      let prevStart = 0;
      for (const m of line.matchAll(/\w+/g)) {
        data.push(
          lineNo - prevLine,
          prevLine === lineNo ? m.index - prevStart : m.index,
          m[0].length,
          /^(if|else|import|pass)$/.test(m[0]) ? 15 : 8,
          0,
        );
        prevLine = lineNo;
        prevStart = m.index;
      }
      return reply(msg.id, { data });
    }
    case 'textDocument/documentSymbol':
      return reply(msg.id, [
        {
          name: 'Foo',
          kind: 5,
          range: span(0, 3),
          selectionRange: range(0, 6),
          children: [{ name: 'bar', kind: 6, range: span(1, 2), selectionRange: range(1, 8) }],
        },
        { name: 'baz', kind: 12, range: span(5, 6), selectionRange: range(5, 4) },
      ]);
    case 'workspace/symbol':
      return reply(msg.id, [
        {
          name: msg.params.query + '_sym',
          kind: 12,
          containerName: 'mod',
          location: {
            uri: pathToFileURL((process.env.FAKE_LSP_ROOT ?? process.cwd()) + '/other.py').href,
            range: range(4, 2),
          },
        },
        { name: 'outside', kind: 12, location: { uri: pathToFileURL('/elsewhere/x.py').href, range: range(0) } },
      ]);
    case 'shutdown':
      return reply(msg.id, null);
    case 'exit':
      return process.exit(0);
    default:
      if (msg.id != null) reply(msg.id, null);
  }
}
