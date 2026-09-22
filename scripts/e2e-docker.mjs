import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const started = Date.now();
const child = spawn('docker', ['compose', 'run', '--build', '--rm', '-T', 'e2e', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    DIFFLE_UID: String(process.getuid?.() ?? 0),
    DIFFLE_GID: String(process.getgid?.() ?? 0),
  },
});
child.on('error', (error) => {
  console.error(`Could not start Docker: ${error.message}\nInstall and start Docker, then retry this command.`);
  process.exitCode = 1;
});
child.on('exit', async (code) => {
  const report = await stat(new URL('../playwright-report/index.html', import.meta.url)).catch(() => null);
  if (report && report.mtimeMs >= started) {
    console.log('\nReport saved in playwright-report/. Open it with: npm run test:e2e:report');
  } else if (code !== 0) {
    console.error(
      '\nNo new test report was generated. Check that Docker is running and the image builds successfully.',
    );
  }
  process.exitCode = code ?? 1;
});
