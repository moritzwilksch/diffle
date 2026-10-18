import type { LspLogEntry, LspLogLevel, LspLogSource, LspProcessStatus } from '../../shared/protocol.js';

/** The status fields one piece of output moves. */
export type OutputChange =
  | Pick<LspProcessStatus, 'log'>
  | Pick<Required<LspProcessStatus>, 'notice'>
  | Pick<Required<LspProcessStatus>, 'activity'>;

/** Log lines kept per server; older ones are dropped. */
const LOG_CAPACITY = 200;
/** LSP `MessageType` numbers; anything else, such as the newer Debug, reads as a plain log line. */
const MESSAGE_LEVELS: Record<number, LspLogLevel> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'log' };

interface Progress {
  title: string;
  message?: string;
  percentage?: number;
}

/**
 * What one server reports while it runs: its output channel (what it showed, what it
 * logged, what it wrote to stderr), the notice it shows the reader, and the progress it
 * runs. Each change goes to `onChange` as the status fields it moves. Only the log's
 * summary travels with the status: the lines are fetched by whoever shows them.
 */
export class ServerOutput {
  /** Oldest first. */
  private log: LspLogEntry[] = [];
  private nextLogId = 1;
  private logSummary: LspProcessStatus['log'] = { seq: 0, errors: 0, warnings: 0 };
  /** stderr bytes since the last newline. */
  private stderrTail = '';
  private notice: LspProcessStatus['notice'];
  private progress = new Map<string | number, Progress>();

  constructor(private readonly onChange: (change: OutputChange) => void) {}

  /** The retained log lines, oldest first. */
  entries(): LspLogEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  summary(): LspProcessStatus['log'] {
    return this.logSummary;
  }

  /** Whole stderr lines go to the log; a trailing partial line waits for its newline. */
  stderr(chunk: string): void {
    const lines = (this.stderrTail + chunk).split('\n');
    this.stderrTail = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.record('stderr', 'log', line);
    }
  }

  /** A server-to-client message: `window/*Message*` lands in the log, `$/progress` in the activity. */
  message(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const p = params as Record<string, unknown>;
    if (method === 'window/showMessage' || method === 'window/logMessage' || method === 'window/showMessageRequest') {
      if (typeof p.message !== 'string' || !p.message.trim()) return;
      const level = MESSAGE_LEVELS[p.type as number] ?? 'log';
      // Everything lands in the log. Only what the server shows the reader, and only a problem,
      // stands as the notice: an editor pops those up and files the rest in an output channel.
      this.record(method === 'window/logMessage' ? 'log' : 'message', level, p.message);
      if (method === 'window/logMessage' || (level !== 'error' && level !== 'warning')) return;
      const notice = { severity: level, message: p.message.trim() };
      if (notice.severity === this.notice?.severity && notice.message === this.notice.message) return;
      this.notice = notice;
      this.onChange({ notice });
      return;
    }
    if (method === '$/progress') this.noteProgress(p);
  }

  /**
   * Appends to the log, folding a line the server repeats into the previous entry's
   * count, and reports that the log moved.
   */
  private record(source: LspLogSource, level: LspLogLevel, message: string): void {
    const text = message.trim();
    if (!text) return;
    const last = this.log[this.log.length - 1];
    if (last && last.source === source && last.level === level && last.message === text) {
      last.count += 1;
      last.time = Date.now();
    } else {
      this.log.push({ id: this.nextLogId++, time: Date.now(), source, level, message: text, count: 1 });
      if (this.log.length > LOG_CAPACITY) this.log.shift();
    }
    this.logSummary = {
      seq: this.logSummary.seq + 1,
      errors: this.logSummary.errors + (level === 'error' ? 1 : 0),
      warnings: this.logSummary.warnings + (level === 'warning' ? 1 : 0),
    };
    this.onChange({ log: this.logSummary });
  }

  /** Work-done progress by token; the activity lists every piece still running. */
  private noteProgress(p: Record<string, unknown>): void {
    if (typeof p.token !== 'string' && typeof p.token !== 'number') return;
    if (!p.value || typeof p.value !== 'object') return;
    const { kind, title, message, percentage } = p.value as Record<string, unknown>;
    const percent = typeof percentage === 'number' && percentage >= 0 && percentage <= 100 ? percentage : undefined;
    if (kind === 'begin' && typeof title === 'string') {
      this.progress.set(p.token, {
        title,
        message: typeof message === 'string' ? message : undefined,
        percentage: percent,
      });
    } else if (kind === 'report' && this.progress.has(p.token)) {
      if (typeof message === 'string') this.progress.get(p.token)!.message = message;
      if (percent !== undefined) this.progress.get(p.token)!.percentage = percent;
    } else if (kind === 'end') {
      if (!this.progress.delete(p.token)) return;
    } else return;
    this.onChange({
      activity: [...this.progress.values()].map(
        (p) => `${p.title}${p.percentage == null ? '' : ` (${p.percentage}%)`}${p.message ? `: ${p.message}` : ''}`,
      ),
    });
  }
}
