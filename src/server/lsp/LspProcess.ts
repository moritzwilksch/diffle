import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { LspFeature, LspLogEntry, LspProcessStatus } from '../../shared/protocol.js';
import { configurationItems, type LspSettings } from './configuration.js';
import { JsonRpcConnection, JsonRpcError } from './JsonRpc.js';
import { ServerOutput } from './ServerOutput.js';
import { CLIENT_CAPABILITIES, DEFAULT_TOKEN_TYPES, FEATURES, featureOf } from './shapes.js';
import { programOf } from './which.js';

export interface LspProcessOptions {
  /** Shell command line that starts a stdio language server, e.g. `pyrefly lsp`. */
  command: string;
  /** Repository root; becomes the workspace folder and the process cwd. */
  root: string;
  /** Settings sent after initialization and returned for workspace/configuration requests. */
  settings?: Promise<LspSettings>;
  /** Sent with `initialize`, for servers configured there rather than through settings. */
  initializationOptions?: LspSettings;
  /** Features counted as advertised whatever `initialize` says (see `ServerDefinition.assumes`). */
  assumes?: LspFeature[];
  onStatus: (status: LspProcessStatus) => void;
  /** Test seam: replaces `spawn(command, { shell: true })`. */
  spawnProcess?: (command: string, cwd: string) => ChildProcess;
}

/** The server is off, still starting, gone, or does not offer what was asked. Routes answer 409. */
export class LspUnavailableError extends Error {}
/** The server never advertised the feature, in `initialize` or since. Advisory requests answer nothing instead. */
export class LspUnsupportedError extends LspUnavailableError {}

// Params of the registration requests a server sends; the misspelling is the spec's.
const RegistrationsSchema = z.object({
  registrations: z.array(z.object({ id: z.string(), method: z.string(), registerOptions: z.unknown().optional() })),
});
const UnregistrationsSchema = z.object({ unregisterations: z.array(z.object({ id: z.string() })) });
const LegendSchema = z.object({ legend: z.object({ tokenTypes: z.string().array() }) });

const INIT_TIMEOUT_MS = 60_000;
/** Graceful shutdown budget. Both together stay under the CLI's hard exit deadline (main.ts). */
const SHUTDOWN_RPC_MS = 500;
const SIGKILL_AFTER_MS = 500;
/**
 * `shell: true` runs the command under `sh -c`, so a plain kill would stop the
 * shell and orphan the language server. On POSIX the child leads its own process
 * group (`detached`), and shutdown signals the whole group.
 */
const DETACH = process.platform !== 'win32';

/**
 * One language server process: the only module that spawns one. Runs the
 * `initialize` handshake, keeps the status (with what `ServerOutput` reports), and
 * shuts it down. Speaks no document or query protocol: that is `Documents` and
 * `LspBridge`. Never throws from the constructor; failures become a status the UI
 * can show.
 */
export class LspProcess {
  private child: ChildProcess | null = null;
  private rpc: JsonRpcConnection | null = null;
  private current: LspProcessStatus;
  private readonly ready: Promise<void>;
  private closing = false;
  private ownsGroup = false;
  /** What the server reports; each change lands on the status unless the process is done. */
  private readonly output = new ServerOutput((change) => {
    if (!this.closing && this.current.state !== 'unavailable') this.set({ ...this.current, ...change });
  });
  /** Features the server offers, from `initialize` and from registrations since. */
  private advertised = new Set<LspFeature>();
  /** Dynamic registrations by their id, so an unregistration knows which feature it ends. */
  private registrations = new Map<string, LspFeature>();
  /** Semantic token legend from the server's capabilities, else the spec's default numbering. */
  tokenTypes: string[] = DEFAULT_TOKEN_TYPES;

  constructor(private readonly opts: LspProcessOptions) {
    this.current = {
      name: programOf(opts.command),
      command: opts.command,
      state: 'starting',
      log: this.output.summary(),
    };
    this.ready = this.launch();
    this.ready.catch(() => {});
  }

  /** How messages name the server: `basedpyright-langserver --stdio` → `basedpyright-langserver`. */
  get name(): string {
    return this.current.name;
  }

  status(): LspProcessStatus {
    return this.current;
  }

  /** The retained log lines, oldest first. */
  entries(): LspLogEntry[] {
    return this.output.entries();
  }

  /** Whether the server advertised `feature`, at `initialize` or by registering it since. False until initialized. */
  supports(feature: LspFeature): boolean {
    return this.advertised.has(feature);
  }

  features(): LspFeature[] {
    return [...this.advertised];
  }

  /** The background work the server reports, as a reason an empty answer may be incomplete; null when idle. */
  busy(): string | null {
    const work = this.current.activity?.length ? this.current.activity.join('; ') : null;
    return work ? `${this.name} is busy: ${work}; try again when it finishes` : null;
  }

  /** The connection once initialized; throws LspUnavailableError when the server is gone. */
  async connection(): Promise<JsonRpcConnection> {
    try {
      await this.ready;
    } catch {
      throw new LspUnavailableError(this.current.message ?? 'language server unavailable');
    }
    if (this.current.state !== 'ready' || !this.rpc)
      throw new LspUnavailableError(this.current.message ?? 'language server unavailable');
    return this.rpc;
  }

  async close(): Promise<void> {
    this.closing = true;
    const rpc = this.rpc;
    const child = this.child;
    if (rpc && child && child.exitCode == null) {
      try {
        await rpc.request('shutdown', null, SHUTDOWN_RPC_MS);
        rpc.notify('exit', null);
      } catch {
        /* the process is killed below regardless */
      }
    }
    if (child && child.exitCode == null) {
      const exited = new Promise<void>((res) => child.once('exit', () => res()));
      const timer = setTimeout(() => this.kill(child, 'SIGKILL'), SIGKILL_AFTER_MS);
      timer.unref();
      this.kill(child, 'SIGTERM');
      await exited;
      clearTimeout(timer);
    }
  }

  /**
   * Signals the child's process group when we made it a group leader, else the
   * child alone. On Windows `shell: true` means the child is cmd.exe, so the tree
   * below it is killed explicitly.
   */
  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid != null && process.platform === 'win32' && !this.opts.spawnProcess) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
      return;
    }
    if (this.ownsGroup && child.pid != null) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* group already gone; fall through to the child itself */
      }
    }
    child.kill(signal);
  }

  private async launch(): Promise<void> {
    let child: ChildProcess;
    try {
      child = this.opts.spawnProcess
        ? this.opts.spawnProcess(this.opts.command, this.opts.root)
        : spawn(this.opts.command, {
            cwd: this.opts.root,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: DETACH,
          });
      this.ownsGroup = !this.opts.spawnProcess && DETACH;
    } catch (e) {
      this.fail(`cannot start "${this.opts.command}": ${(e as Error).message}`);
      throw e;
    }
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => this.output.stderr(d.toString('utf8')));
    child.on('error', (e) => this.fail(`cannot start "${this.opts.command}": ${e.message}`));
    child.on('exit', (code, signal) => {
      if (this.closing) return;
      // A trailing partial line lands in the log, which is where the reason lives.
      this.output.stderr('\n');
      this.fail(`"${this.opts.command}" exited (${signal ?? code})`);
    });
    if (!child.stdin || !child.stdout) {
      this.fail(`cannot start "${this.opts.command}": no stdio`);
      throw new Error('no stdio');
    }
    const rpc = new JsonRpcConnection(child.stdout, child.stdin);
    this.rpc = rpc;
    rpc.onMessage((method, params) => {
      if (!this.closing && this.current.state !== 'unavailable') this.output.message(method, params);
    });
    rpc.onRequest('workspace/configuration', async (params) =>
      configurationItems((await this.opts.settings) ?? {}, params),
    );
    rpc.onRequest('client/registerCapability', (params) => this.register(params));
    rpc.onRequest('client/unregisterCapability', (params) => this.unregister(params));
    const rootUri = pathToFileURL(this.opts.root).href;
    try {
      const init = await rpc.request<{
        capabilities?: Record<string, unknown> & { semanticTokensProvider?: { legend?: { tokenTypes?: string[] } } };
      }>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'diffle' },
          rootUri,
          rootPath: this.opts.root,
          workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
          initializationOptions: this.opts.initializationOptions,
          capabilities: CLIENT_CAPABILITIES,
        },
        INIT_TIMEOUT_MS,
      );
      const capabilities = init?.capabilities ?? {};
      for (const [feature, { provider }] of Object.entries(FEATURES) as [LspFeature, { provider: string }][])
        if (capabilities[provider]) this.advertised.add(feature);
      for (const feature of this.opts.assumes ?? []) this.advertised.add(feature);
      const legend = capabilities.semanticTokensProvider?.legend?.tokenTypes;
      if (legend?.length) this.tokenTypes = legend;
      rpc.notify('initialized', {});
      if (this.opts.settings) {
        const settings = await this.opts.settings;
        if (!this.closing) rpc.notify('workspace/didChangeConfiguration', { settings });
      }
    } catch (e) {
      this.fail(`initialize failed: ${(e as Error).message}`);
      throw e;
    }
    if (this.current.state === 'starting') this.set({ ...this.current, state: 'ready' });
  }

  /**
   * A feature the server offers from now on, as an editor takes it: counted like one
   * advertised at `initialize`, with a semantic token legend read from the options.
   */
  private register(params: unknown): null {
    const request = RegistrationsSchema.safeParse(params);
    if (!request.success) throw new JsonRpcError(-32602, 'Invalid client/registerCapability parameters');
    for (const { id, method, registerOptions } of request.data.registrations) {
      const feature = featureOf(method);
      if (!feature) continue;
      this.registrations.set(id, feature);
      this.advertised.add(feature);
      const legend = feature === 'semanticTokens' ? LegendSchema.safeParse(registerOptions) : null;
      if (legend?.success && legend.data.legend.tokenTypes.length) this.tokenTypes = legend.data.legend.tokenTypes;
    }
    this.opts.onStatus(this.current);
    return null;
  }

  private unregister(params: unknown): null {
    const request = UnregistrationsSchema.safeParse(params);
    if (!request.success) throw new JsonRpcError(-32602, 'Invalid client/unregisterCapability parameters');
    for (const { id } of request.data.unregisterations) {
      const feature = this.registrations.get(id);
      if (!feature) continue;
      this.registrations.delete(id);
      this.advertised.delete(feature);
    }
    this.opts.onStatus(this.current);
    return null;
  }

  private fail(message: string): void {
    if (this.current.state === 'unavailable') return;
    this.set({
      name: this.current.name,
      command: this.opts.command,
      state: 'unavailable',
      message,
      log: this.output.summary(),
    });
    this.rpc?.dispose(new LspUnavailableError(message));
  }

  private set(status: LspProcessStatus): void {
    this.current = status;
    this.opts.onStatus(status);
  }
}
