/**
 * Two moments of the app's start that went wrong together once (issue #339): the offer to move
 * into the Applications folder, and the window a click on the Dock icon brings up. Electron's
 * parts are passed in (src/desktop/main.ts), so both are tested without it.
 */

export interface MoveOffer {
  /** Packed, not a smoke run, and not in the Applications folder yet. */
  offered: boolean;
  /** The question; true for «Verschieben». */
  ask(): Promise<boolean>;
  /** Electron's `app.moveToApplicationsFolder`: true when the app was moved. It then quits this process and starts the moved one. */
  move(): boolean;
  failed(reason: string): Promise<void>;
}

/**
 * `moved`: this process is on its way out and the app in the Applications folder starts in its
 * place; the caller must start nothing more here (no server, no state file, no window: its own
 * files are in the Trash by then). `stays`: the start goes on.
 */
export async function offerMove(o: MoveOffer): Promise<'moved' | 'stays'> {
  if (!o.offered || !(await o.ask())) return 'stays';
  try {
    if (o.move()) return 'moved';
  } catch (e) {
    await o.failed((e as Error).message);
  }
  return 'stays';
}

export interface AppWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** A window created hidden: since when it waits for its first paint. */
export interface Waiting { since: number }

/** How long a hidden window may wait for its first paint before a click on the Dock icon shows it unpainted. */
export const PAINT_GRACE_MS = 4000;

/**
 * A click on the Dock icon, `open -a`, a second start: the window comes to the front, whatever
 * became of it. None (closed): `create` opens one. One that waits hidden for its first paint is
 * left to it (macOS sends this on every ordinary start too, and an empty frame would flash);
 * one that has waited longer than PAINT_GRACE_MS is shown as it is, since a running app without
 * a window leaves the person nothing to click. A page that fails to load is windowLoader's.
 */
export function bringUp(win: AppWindow | undefined, create: () => void, waiting: Waiting, now = Date.now()): void {
  if (!win || win.isDestroyed()) { create(); return; }
  if (win.isMinimized()) win.restore();
  else if (!win.isVisible()) {
    if (now - waiting.since < PAINT_GRACE_MS) return;
    win.show();
  }
  win.focus();
}

/** Chromium's ERR_ABORTED: a load replaced by the next one, no failure. */
const ABORTED = -3;

/** The pauses between the tries of a page load that failed: under 10 s in all, then it is said. */
export const LOAD_RETRY_MS: readonly number[] = [250, 500, 1000, 2000, 3000, 3000];

export type Loaded = { result: 'loaded' | 'replaced' | 'closed' } | { result: 'failed'; reason: string };

/**
 * Loads the window's page, and again after a pause when the load failed. Seen in the packed app
 * (issue #363): after «Verschieben» the relaunched app's first load failed at once with
 * ERR_FAILED, Chromium's network process having been restarted while macOS's question about the
 * Documents folder held the main process; nothing loaded the page again, so the window stayed
 * hidden, then blank. `alive` is false once the window is closed; `replaced`: another load took
 * its place.
 */
export async function loadPage(
  load: () => Promise<unknown>, alive: () => boolean,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Loaded> {
  for (let i = 0; ; i++) {
    try {
      await load();
      return { result: 'loaded' };
    } catch (e) {
      if ((e as { errno?: number }).errno === ABORTED) return { result: 'replaced' };
      const wait = LOAD_RETRY_MS[i];
      if (wait === undefined) return { result: 'failed', reason: (e as Error).message };
      await pause(wait);
      if (!alive()) return { result: 'closed' };
    }
  }
}

export interface PageWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  loadURL(url: string): Promise<unknown>;
}

/**
 * The loads of one window: the newest wins. A load still trying again after a failure gives up
 * once a newer one started (a menu command, a Dock click), so it never puts its page over the
 * newer one. A page loaded after a failed try may never send `ready-to-show`: loaded, a hidden
 * window is shown. A load that never succeeds calls `failed`; `first` is true only for the
 * start's first page, which is the only one that may end the app (main.ts).
 */
export function windowLoader(
  win: PageWindow, failed: (reason: string, first: boolean) => void,
  pause?: (ms: number) => Promise<void>,
): (url: string, first?: boolean) => Promise<Loaded> {
  let newest = 0;
  return async (url, first = false) => {
    const mine = ++newest;
    const current = () => !win.isDestroyed() && newest === mine;
    const r = await loadPage(() => win.loadURL(url), current, pause);
    if (r.result === 'loaded' && current() && !win.isVisible()) win.show();
    if (r.result === 'failed' && current()) failed(r.reason, first);
    return r;
  };
}

/** How long the start waits for the folder of the books opened last before the window comes without them. */
export const REACH_WAIT_MS = 400;

export interface FirstPage<B> {
  /** desktop.json's newest recent folder; none on a first start. */
  last?: string;
  /** DesktopServer.reach: asynchronous, held while macOS asks about the folder; `ok` or `missing` once it may be read. */
  reach(root: string): Promise<string>;
  /** DesktopServer.answered: whether macOS answered for the folder of `root` to this version of the app already. */
  answered(root: string): boolean;
  /** The start screen that says why macOS will ask before it opens `root` (unaskedPath). */
  unasked(root: string): string;
  open(root: string): Promise<B>;
  /** Books opened meanwhile (she chose on the start screen): the last ones then stay shut. */
  current(): unknown;
  pathOf(books: B | undefined): string;
  /** The start screen while macOS asks about `root`'s folder: it says so (askingPath). */
  asking(root: string): string;
  show(path: string): void;
  wait?: (ms: number) => Promise<void>;
}

/** The start screen saying that macOS asks about the folder of `root`, the books named `name`, in the protected `folder`. */
export const askingPath = (root: string, name: string, folder: string): string =>
  `/start?${new URLSearchParams({ asking: root, name, folder })}`;

/**
 * The start screen that offers the books in `root` with the words before macOS's question: their
 * folder `folder` is read only once she clicks «Weiter» there (#373).
 */
export const unaskedPath = (root: string, name: string, folder: string): string =>
  `/start?${new URLSearchParams({ unasked: root, name, folder })}`;

/**
 * The start's first window (issue #373). A first start shows it at once and reads no folder. A
 * later start opens the books opened last before it shows them, as long as their folder answers
 * at once; when macOS holds that look (it asks whether the app may read Documents, Desktop or
 * Downloads, and waits for «Erlauben»), the window comes first with the start screen, which says
 * so, and the books follow once she allowed it: never a synchronous read macOS holds with the
 * main process. Refused, the plain start screen stays (its list says how to allow it). Books in a
 * folder macOS has not answered for to this version of the app (a first start after an update
 * loses an unsigned build's permission) are not read at all: the start screen says first why macOS
 * will ask, and she opens them from there.
 */
export async function firstPage<B>(o: FirstPage<B>): Promise<void> {
  if (!o.last) { o.show('/'); return; }
  const last = o.last;
  if (!o.answered(last)) { o.show(o.unasked(last)); return; }
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const open = () => o.open(last).catch(() => undefined);
  const reached = o.reach(last).catch(() => 'ok');
  const quick = await Promise.race([reached, wait(REACH_WAIT_MS).then(() => undefined)]);
  if (quick !== undefined) { o.show(o.pathOf(await open())); return; }
  o.show(o.asking(last));
  const answer = await reached;
  if (o.current()) return;
  if (answer === 'refused' || answer === 'locked') { o.show('/start'); return; }
  o.show(o.pathOf(await open()));
}

/**
 * `run` on the first call only, its failure logged: the phone's listener starts again when the first
 * books open (main.ts onOpen), not at every later open and never before the first window (#373).
 */
export function resumeOnce(run: () => Promise<unknown>): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void run().catch((e: unknown) => console.error('phone:', e));
  };
}
