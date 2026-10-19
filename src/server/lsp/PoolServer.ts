import type { LanguageId, LspProjects, LspServerStatus } from '@/shared/protocol.js';
import { LspBridge, type LspBridgeOptions } from './LspBridge.js';
import { definitionOf, type ResolvedServer, type ServerContext, type ServerDefinition } from './registry.js';
import { findOnPath } from './which.js';

export type PoolServerOptions = Pick<LspBridgeOptions, 'root' | 'read' | 'has' | 'spawnProcess' | 'maxOpen'> & {
  /** Its status moved. */
  onStatus: () => void;
  /** Test seam for the PATH probe. */
  lookup?: (command: string) => string | null;
};

/** The diff's files by language. */
export type PathsByLanguage = ReadonlyMap<LanguageId, readonly string[]>;

/**
 * One server of the pool: its bridge, the languages routed to it, both lists growing as
 * later snapshots resolve to the same command, and what its definition pointed it at
 * from the diff's files.
 */
export class PoolServer implements ResolvedServer {
  readonly bridge: LspBridge;
  readonly languages: LanguageId[] = [];
  readonly joins: LanguageId[] = [];
  private readonly definition: ServerDefinition;
  /** Every diff file it has answered for, so settings that follow them only grow. */
  private readonly paths: Set<string>;
  private projects: LspProjects | undefined;

  constructor(
    readonly command: string,
    paths: readonly string[],
    private readonly opts: PoolServerOptions,
  ) {
    this.definition = definitionOf(command);
    this.paths = new Set(paths);
    const ctx = this.context();
    this.projects = this.definition.projects?.(ctx);
    this.bridge = new LspBridge({
      command,
      settings: this.definition.settings ? Promise.resolve(this.definition.settings(ctx)) : undefined,
      initializationOptions: this.definition.initializationOptions?.(ctx),
      root: opts.root,
      read: opts.read,
      has: opts.has,
      onStatus: opts.onStatus,
      spawnProcess: opts.spawnProcess,
      maxOpen: opts.maxOpen,
    });
  }

  status(): LspServerStatus {
    return {
      ...this.bridge.status(),
      languages: [...this.languages],
      joins: [...this.joins],
      supports: this.bridge.features(),
      ...(this.projects && { projects: this.projects }),
    };
  }

  /**
   * Takes in the diff's files for its languages. When they add one and its settings
   * follow them, the server gets new settings, and the status moves if what it is
   * pointed at did.
   */
  follow(paths: readonly string[]): void {
    const known = this.paths.size;
    for (const p of paths) this.paths.add(p);
    const { settings, projects, reconfigures } = this.definition;
    if (this.paths.size === known || !reconfigures) return;
    const ctx = this.context();
    if (settings) this.bridge.reconfigure(Promise.resolve(settings(ctx)));
    const now = projects?.(ctx);
    if (JSON.stringify(now) === JSON.stringify(this.projects)) return;
    this.projects = now;
    this.opts.onStatus();
  }

  private context(): ServerContext {
    return { root: this.opts.root, paths: [...this.paths], lookup: this.opts.lookup ?? findOnPath };
  }
}

/** The diff's files for a server's languages, owned and joined. */
export function pathsOf(server: Pick<ResolvedServer, 'languages' | 'joins'>, byLanguage: PathsByLanguage): string[] {
  return [...server.languages, ...server.joins].flatMap((l) => byLanguage.get(l) ?? []);
}
