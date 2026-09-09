/** Per-phase startup timings, printed with --timing. */
export class Timing {
  private readonly t0 = performance.now();
  private readonly marks: [name: string, ms: number][] = [];

  constructor(private readonly enabled: boolean) {}

  mark(name: string): void {
    if (this.enabled) this.marks.push([name, performance.now() - this.t0]);
  }

  report(): void {
    if (!this.enabled) return;
    const width = Math.max(...this.marks.map(([n]) => n.length));
    let prev = 0;
    for (const [name, ms] of this.marks) {
      console.error(`[timing] ${name.padEnd(width)}  +${(ms - prev).toFixed(1).padStart(7)} ms  @${ms.toFixed(1).padStart(7)} ms`);
      prev = ms;
    }
  }
}
