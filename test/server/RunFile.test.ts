import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunFile } from '../../src/server/RunFile.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-run-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const info = (pid: number) => ({ port: 4966, url: 'http://127.0.0.1:4966/', pid, root: '/r', commentKey: 'working', startedAt: 1 });

describe('RunFile', () => {
  it('writes owner-only and reads back while the pid is alive', async () => {
    const rf = new RunFile(dir);
    await rf.write(info(process.pid));
    expect(await rf.read()).toEqual(info(process.pid));
    expect((await stat(rf.file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'diffle'))).mode & 0o777).toBe(0o700);
    expect(await new RunFile(join(dir, 'elsewhere')).read()).toBeNull();
  });

  it('removes a file whose pid is gone or whose contents are malformed', async () => {
    const rf = new RunFile(dir);
    // A process that has already exited.
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise((res) => child.once('exit', res));
    await rf.write(info(pid));
    expect(await rf.read()).toBeNull();
    await expect(readFile(rf.file)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(rf.file, '{broken');
    expect(await rf.read()).toBeNull();
    await expect(readFile(rf.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removeIfOwn leaves a newer server’s file alone', async () => {
    const rf = new RunFile(dir);
    await rf.write(info(process.pid + 1));
    await rf.removeIfOwn(process.pid);
    expect(JSON.parse(await readFile(rf.file, 'utf8')).pid).toBe(process.pid + 1);
    await rf.write(info(process.pid));
    await rf.removeIfOwn(process.pid);
    await expect(readFile(rf.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
