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
import type { Channel, ChildMessage, ParentMessage, Yielded } from './model.js';

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
