import { spawn } from 'node:child_process';

/** Opens a URL in the default browser. Detached; never awaited. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.error(`🌐 could not open a browser; visit ${url}`));
    child.unref();
  } catch {
    console.error(`🌐 could not open a browser; visit ${url}`);
  }
}
