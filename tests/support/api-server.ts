/**
 * Runs the real API server (src/server/main.ts) as a child process on a temp workspace holding a
 * copy of a fixture index, so a test reads and writes only that copy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempWorkspace, writeIndex } from './workspace.js';
import { workspaceAt, type Workspace } from '../../src/workspace/workspace.js';
import { loadBooks } from '../../src/books/store.js';

const REPO = process.cwd();

export interface ApiServer {
  root: string;
  port: number;
  /** The temp workspace the server runs on. */
  ws: Workspace;
  send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /**
   * A request on a connection of its own. On a busy machine the server's event loop can stall past
   * its keep-alive timeout; it then closes the idle connection before reading the request the
   * client already sent on it, and the request fails with ECONNRESET.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** What the server printed so far. */
  output(): string;
  /**
   * Waits until no run is running or queued. A run a request started writes the books after the
   * request answered: a test that writes the books itself waits for it first, or the run's save
   * overwrites what the test wrote (#71).
   */
  rest(): Promise<void>;
  /** Ends the server and waits for its exit before removing its folders: a run it drives may still write. */
  stop(): Promise<void>;
}

/**
 * `env` is added to the server's environment. The temp workspace has the demo manifest and a stub
 * prior-year history/ for classify's prompt. The server finds tests/support/no-model-bin/claude
 * first unless `env.PATH` says otherwise, and listens on 127.0.0.1 unless `env.VANILLA_API_HOST`
 * says otherwise ('' for every interface). `manifestOf`: another workspace's manifest (a demo of
 * another kind of firm) instead of the demo's. `whole`: the fixture is a workspace copied whole (its receipts, invoices,
 * knowledge; without its local data/) instead of its books alone.
 */
export async function startApi(fixture: string, env: Record<string, string> = {}, { manifestOf, whole = false }: { manifestOf?: string; whole?: boolean } = {}): Promise<ApiServer> {
  const ws = tempWorkspace('belege-api-', manifestOf);
  const { paths } = ws;
  const root = paths.root;
  const source = join(REPO, fixture);
  if (whole) {
    cpSync(source, root, { recursive: true, filter: (src) => src !== join(source, 'data') });
  } else {
    mkdirSync(paths.history);
    writeFileSync(join(paths.history, 'prior-year.Konten.txt'), '1021\tBank\n4400\tAufwand für bezogene Dienstleistungen\n6570\tInformatikaufwand\n');
    writeFileSync(join(paths.history, 'prior-year.Buchungen-sample.tsv'), 'Datum\tBeschreibung\tKtSoll\tKtHaben\tBetrag\n');
    // A fixture is an index (books.json's content before ADR 0013), or a workspace whose books are copied.
    writeIndex(ws, source.endsWith('.json') ? JSON.parse(readFileSync(source, 'utf8')) : JSON.parse(JSON.stringify(loadBooks(workspaceAt(source)))));
  }
  // The runs and the approvals live outside the workspace, by default in the user's application data.
  const outside = [`${root}-runs`, `${root}-approvals`];
  const server: ChildProcess = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', import.meta.resolve('./exit-with-parent.ts'), join(REPO, 'src/server/main.ts')], {
    cwd: root,
    env: { ...process.env, PATH: `${join(REPO, 'tests/support/no-model-bin')}:${process.env.PATH}`, VANILLA_WORKSPACE: root, VANILLA_KEYCHAIN: 'off', VANILLA_RUNS_DIR: outside[0], VANILLA_APPROVALS_DIR: outside[1], VANILLA_API_HOST: '127.0.0.1', PORT: '0', READONLY: '', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // The server takes the port the system gives 127.0.0.1 and names it: a port probed here and
  // passed on could meanwhile belong to another process, and a wildcard listen shares a port with a
  // process listening on 127.0.0.1 alone, which then gets the test's requests.
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    server.once('exit', (code) => reject(new Error(`API exited with ${code}`)));
    server.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/API server running on port (\d+)/);
      if (m) resolve(Number(m[1]));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Connection', 'close');
    return fetch(base + path, { ...init, headers });
  };
  return {
    port,
    root,
    ws,
    fetch: request,
    output: () => out,
    async send(method, path, body) {
      const res = await request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
    },
    async rest() {
      for (let i = 0; i < 400; i++) {
        const v = (await (await request('/api/automation')).json()) as { runs: Array<{ status: string }> };
        if (!v.runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the runs did not come to rest');
    },
    async stop() {
      if (server.exitCode === null && server.signalCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
      for (const dir of [root, ...outside]) rmSync(dir, { recursive: true, force: true });
    },
  };
}
