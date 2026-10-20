/**
 * Starting a source's code (ADR 0014): in a child process behind the fence (child.mjs), with no
 * environment of the host, read-only to the source's folder. `runFeed` drives one feed: it starts
 * the child, answers its channel calls through the host's `call`, and hands on what the feed
 * yields, one item at a time (the child waits for the host after each). The launcher is the seam
 * where a cloud runtime puts its own isolate in place of a process.
 */
import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Channel, ChildMessage, ParentMessage, SourceDecl, Yielded } from './model.js';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'child.mjs');

export interface ChildHandle {
  send(m: ParentMessage): void;
  onMessage(f: (m: ChildMessage) => void): void;
  /** `stderr`: what the child printed when it failed. */
  onExit(f: (code: number | null, stderr: string) => void): void;
  kill(): void;
}

export interface Launcher { start(folder: string): ChildHandle }

/**
 * Whether a source's code can run in this process: not in the Mac app, whose fuses keep its own
 * binary from running as node (ADR 0014, unit 2b: its utility-process launcher is not built yet).
 * There a fork would start the app a second time, so nothing is pulled; the host's own part (a
 * mailbox's connection check in Firma › Quellen) runs there all the same.
 */
export const sourcesRunHere = (): boolean => !process.versions.electron;

/**
 * Why a source cannot run in this process, or nothing when it can. In the Mac app: a company's own
 * code needs the fenced child (`fence`), and a mailbox over IMAP its mail client, which the app does
 * not pack (`imap`, docs/desktop.md). The app's own code over the Mail app of the Mac runs there.
 */
export function whyNotHere(decl: Pick<SourceDecl, 'code' | 'reach'>): 'fence' | 'imap' | undefined {
  if (sourcesRunHere()) return undefined;
  if (decl.code.kind === 'own') return 'fence';
  if (decl.reach.mail) return 'imap';
  return undefined;
}

/** The launcher a source runs with here: the fenced child where it can start, else the app's own code in this process. */
export const launcherFor = (decl: Pick<SourceDecl, 'code'>): Launcher => (sourcesRunHere() || decl.code.kind === 'own' ? nodeLauncher : inProcessLauncher);

/**
 * The app's own source code, run in this process (the Mac app, ADR 0014 unit 2b open): the code
 * the app ships is as trusted as the rest of the app, so it needs no fence, only the same protocol
 * as the child (child.mjs): it calls channels through the host, yields one item at a time.
 */
export const inProcessLauncher: Launcher = {
  start() {
    let onMsg: (m: ChildMessage) => void = () => {};
    let waiting: (() => void) | undefined;
    let calls = 0;
    let stopped = false;
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    const emit = (m: ChildMessage) => { if (!stopped) queueMicrotask(() => onMsg(m)); };
    const channel = (name: Channel) => new Proxy({}, {
      get: (_t, method) => (...args: unknown[]) => new Promise((resolve, reject) => {
        const id = ++calls;
        pending.set(id, { resolve, reject });
        emit({ type: 'call', id, channel: name, method: String(method), args });
      }),
    });
    const out = {
      document: (file: string, o: { key?: string; date?: string } = {}) => ({ kind: 'document', file, key: o.key, date: o.date }),
      record: (record: unknown, o: { key?: string } = {}) => ({ kind: 'record', record, key: o.key }),
      checkpoint: (cursor: unknown) => ({ kind: 'checkpoint', cursor }),
    };
    async function run(m: Extract<ParentMessage, { type: 'start' }>) {
      try {
        const mod = (await import(m.entry)) as { default?: Record<string, (io: unknown, from: unknown) => AsyncIterable<Yielded>> };
        const feed = mod.default?.[m.feed];
        if (typeof feed !== 'function') throw new Error(`the code has no feed "${m.feed}"`);
        const io = { mail: channel('mail'), web: channel('web'), api: channel('api'), out, settings: Object.freeze({ ...m.settings }), log: (text: string) => emit({ type: 'log', text: String(text) }) };
        for await (const item of feed(io, m.from)) {
          if (stopped) return;
          emit({ type: 'yield', item });
          await new Promise<void>((resolve) => { waiting = resolve; });
        }
        emit({ type: 'end' });
      } catch (e) {
        emit({ type: 'error', message: String((e as Error)?.message ?? e) });
      }
    }
    return {
      send(m) {
        if (m.type === 'start') void run(m);
        else if (m.type === 'reply') { const p = pending.get(m.id); pending.delete(m.id); if (p) { if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); } }
        else { const w = waiting; waiting = undefined; w?.(); }
      },
      onMessage(f) { onMsg = f; },
      // The code runs in this process: it ends by `end` or `error`, never by an exit.
      onExit() {},
      kill() { stopped = true; const w = waiting; waiting = undefined; w?.(); },
    };
  },
};

/** Plain node for the CLI, `npm start` and the tests: --permission, read-only to the folder and the child's own file, no environment. */
export const nodeLauncher: Launcher = {
  start(folder) {
    if (!sourcesRunHere()) throw new Error('The Mac app runs no source yet (ADR 0014, unit 2b): npm start or npm run pull fetches it.');
    const child = fork(CHILD, [], {
      execArgv: ['--permission', `--allow-fs-read=${realpathSync(folder)}`, `--allow-fs-read=${realpathSync(CHILD)}`, '--disable-warning=ExperimentalWarning'],
      env: {},
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    return {
      send: (m) => { if (child.connected) child.send(m); },
      onMessage: (f) => { child.on('message', (m) => f(m as ChildMessage)); },
      onExit: (f) => { child.on('exit', (code) => f(code, stderr.trim())); },
      kill: () => { child.kill(); },
    };
  },
};

/** The code threw (a page or an answer was not what it expected): what it said. */
export class SourceError extends Error {}
/** The child ended without saying so: the fence stopped it, or it crashed. */
export class ChildCrashed extends Error {}

export interface FeedRun {
  folder: string;
  entry: string;
  feed: string;
  from: unknown;
  settings: Record<string, unknown>;
}

/** One feed of a source, item by item. `call` runs a channel's method on the host; the child never holds a connection. */
export async function* runFeed(launcher: Launcher, run: FeedRun, call: (channel: Channel, method: string, args: unknown[]) => Promise<unknown>, log: (text: string) => void = () => {}): AsyncGenerator<Yielded> {
  const child = launcher.start(run.folder);
  const queue: Array<ChildMessage | { type: 'exit'; code: number | null; stderr: string } | { type: 'host'; error: unknown }> = [];
  let wake: (() => void) | undefined;
  const push = (m: (typeof queue)[number]) => { queue.push(m); const w = wake; wake = undefined; w?.(); };
  child.onMessage((m) => {
    if (m.type === 'call') {
      // A failure of the host (a dropped connection, a reach refused) is the host's, not the code's: it ends the feed as itself.
      call(m.channel, m.method, m.args).then(
        (value) => child.send({ type: 'reply', id: m.id, ok: true, value }),
        (error: unknown) => push({ type: 'host', error }),
      );
    } else if (m.type === 'log') log(m.text);
    else push(m);
  });
  child.onExit((code, stderr) => push({ type: 'exit', code, stderr }));
  child.send({ type: 'start', entry: pathToFileURL(realpathSync(join(run.folder, run.entry))).href, feed: run.feed, from: run.from, settings: run.settings });
  try {
    for (;;) {
      while (!queue.length) await new Promise<void>((r) => { wake = r; });
      const m = queue.shift()!;
      if (m.type === 'yield') { yield m.item; child.send({ type: 'next' }); }
      else if (m.type === 'end') return;
      else if (m.type === 'error') throw new SourceError(m.message);
      else if (m.type === 'host') throw m.error;
      else if (m.type === 'exit') throw new ChildCrashed(`the source's code stopped (${m.code ?? 'killed'}): ${m.stderr.split('\n').find((l) => /Error|ERR_/.test(l)) ?? m.stderr.slice(-300)}`);
    }
  } finally {
    child.kill();
  }
}
