/**
 * Runs the real API server (src/server/main.ts) as a child process on a temp workspace holding a
 * copy of a fixture index, so a test reads and writes only that copy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tempWorkspace } from './workspace.js';

const REPO = process.cwd();

export interface ApiServer {
  root: string;
  indexPath: string;
  send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** `env` is added to the server's environment. The temp workspace has the demo manifest and a stub prior-year history/ for classify's prompt. */
export async function startApi(fixture: string, env: Record<string, string> = {}): Promise<ApiServer> {
  const { paths } = tempWorkspace('belege-api-');
  const root = paths.root;
  const indexPath = paths.books;
  mkdirSync(paths.receipts);
  mkdirSync(paths.history);
  writeFileSync(join(paths.history, 'prior-year.Konten.txt'), '1021\tBank\n6570\tInformatikaufwand\n');
  writeFileSync(join(paths.history, 'prior-year.Buchungen-sample.tsv'), 'Datum\tBeschreibung\tKtSoll\tKtHaben\tBetrag\n');
  copyFileSync(join(REPO, fixture), indexPath);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(REPO, 'src/server/main.ts')], {
    cwd: root,
    env: { ...process.env, VANILLA_WORKSPACE: root, PORT: String(port), READONLY: '', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    server.once('exit', (code) => reject(new Error(`API exited with ${code}`)));
    server.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('API server running')) resolve();
    });
  });
  return {
    root,
    indexPath,
    async send(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
    },
    stop() {
      server.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
