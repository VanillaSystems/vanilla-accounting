/**
 * Every file system call of this process under the folders macOS protects (Documents, Desktop,
 * Downloads), recorded (issue #373). On the Mac the first such call makes macOS ask the person
 * whether the app may read the folder, and holds that call until she answers: a synchronous one
 * holds the main process with it (#363). The functions of `node:fs` and `node:fs/promises` are
 * wrapped, and `syncBuiltinESMExports` carries the wrappers into every module's imports.
 * `hold()` makes an asynchronous call there wait as macOS's question does, until `answer()`.
 */
import fs, { mkdirSync, mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Touch { fn: string; kind: 'sync' | 'async'; path: string; folder: string }

export interface ProtectedFolders {
  home: string;
  documents: string;
  desktop: string;
  downloads: string;
  /** Every call under one of them since `start()`. */
  touches: Touch[];
  /** Calls a synchronous one before macOS answered for its folder: what freezes the main process. */
  frozen: Touch[];
  start(): void;
  /** From now on an asynchronous call under a protected folder waits until `answer()`. */
  hold(): void;
  /** macOS's answer: the held calls go on (and the folder counts as answered). */
  answer(): void;
  /** Resolves once a call waits on the question. */
  asked(): Promise<void>;
  /** As at the next start: macOS asks again (a grant by a save panel lasts one run). */
  forget(): void;
  stop(): void;
}

const pathOf = (a: unknown): string | undefined =>
  typeof a === 'string' ? a : a instanceof URL && a.protocol === 'file:' ? fileURLToPath(a) : Buffer.isBuffer(a) ? a.toString() : undefined;

export function protectedFolders(): ProtectedFolders {
  const home = mkdtempSync(join(tmpdir(), 'vanilla-tcc-'));
  const folders = { documents: join(home, 'Documents'), desktop: join(home, 'Desktop'), downloads: join(home, 'Downloads') };
  for (const f of Object.values(folders)) mkdirSync(f);
  const under = (p: string): string | undefined => {
    const r = resolve(p);
    return Object.values(folders).find((f) => r === f || r.startsWith(f + sep));
  };
  const touches: Touch[] = [];
  const frozen: Touch[] = [];
  const answered = new Set<string>();
  let recording = false;
  let holding = false;
  let gate: { promise: Promise<void>; open(): void } | undefined;
  let waiting: Array<() => void> = [];
  let held = 0;
  const restore: Array<() => void> = [];

  const note = (fn: string, kind: Touch['kind'], args: unknown[]): Touch | undefined => {
    if (!recording) return undefined;
    for (const a of args.slice(0, 2)) {
      const p = pathOf(a);
      const folder = p && under(p);
      if (!p || !folder) continue;
      const touch = { fn, kind, path: p, folder };
      touches.push(touch);
      if (kind === 'sync' && !answered.has(folder)) frozen.push(touch);
      return touch;
    }
    return undefined;
  };

  const wrap = (target: Record<string, unknown>, name: string, kind: Touch['kind'] | 'callback') => {
    const original = target[name] as (...a: unknown[]) => unknown;
    if (typeof original !== 'function' || /^[A-Z]/.test(name)) return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (kind === 'sync') { note(name, 'sync', args); return original.apply(this, args); }
      const touch = note(name, 'async', args);
      if (!touch) return original.apply(this, args);
      if (kind === 'callback') {
        const last = args.length - 1;
        const done = args[last];
        if (typeof done === 'function') args[last] = (...r: unknown[]) => { answered.add(touch.folder); (done as (...x: unknown[]) => void)(...r); };
        if (!holding) return original.apply(this, args);
        held++; waiting.forEach((w) => w()); waiting = [];
        void gate!.promise.then(() => original.apply(this, args));
        return undefined;
      }
      const run = () => (original.apply(this, args) as Promise<unknown>).finally(() => answered.add(touch.folder));
      if (!holding) return run();
      held++; waiting.forEach((w) => w()); waiting = [];
      return gate!.promise.then(run);
    };
    target[name] = wrapped;
    restore.push(() => { target[name] = original; });
  };

  const syncNames = Object.keys(fs).filter((n) => n.endsWith('Sync'));
  const callbackNames = Object.keys(fs).filter((n) => !n.endsWith('Sync') && typeof (fs as unknown as Record<string, unknown>)[n] === 'function' && `${n}Sync` in fs);
  for (const n of syncNames) wrap(fs as unknown as Record<string, unknown>, n, 'sync');
  for (const n of callbackNames) wrap(fs as unknown as Record<string, unknown>, n, 'callback');
  for (const n of Object.keys(fs.promises)) wrap(fs.promises as unknown as Record<string, unknown>, n, 'async');
  syncBuiltinESMExports();

  return {
    home, ...folders, touches, frozen,
    start: () => { recording = true; },
    hold: () => {
      holding = true;
      let open = () => {};
      const promise = new Promise<void>((r) => { open = r; });
      gate = { promise, open };
    },
    answer: () => { holding = false; held = 0; gate?.open(); },
    asked: () => new Promise<void>((r) => { if (held) r(); else waiting.push(r); }),
    forget: () => { answered.clear(); frozen.length = 0; },
    stop: () => { recording = false; holding = false; gate?.open(); restore.forEach((r) => r()); syncBuiltinESMExports(); },
  };
}
