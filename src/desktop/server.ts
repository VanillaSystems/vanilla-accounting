/**
 * The desktop app's local server: the start screen's routes under /api/desktop, the built UI, and
 * the books API (src/server/api.ts) once a workspace is open. The books API is imported only then,
 * because it opens its workspace as it loads; another workspace later is switched in place.
 * Switched on in Firma › Handy, a second listener on the local network takes the phone's paths
 * only, with the pairing token (src/server/phone.ts); it is off until then.
 * Nothing here needs Electron, so the tests run it in Node.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import express from 'express';
import { isAppPath } from '../server/app-paths.js';
import { lanAddresses, newPhoneToken, pairingUrl, phoneApp, usePhoneToken } from '../server/phone.js';
import { SetupError, createWorkspace, type SetupRequest } from '../workspace/create.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, WorkspaceError, appFolderIn, openWorkspaceAt, workspaceAt } from '../workspace/workspace.js';
import type { ApiErrorBody } from '../types/api-error.js';
import type { DesktopInfo, KnownBooks, PhoneInfo } from '../types/desktop.js';
import { qrSvg } from './qr.js';
import { opened, readState, writeState, type PhonePairing } from './state.js';

export interface DesktopServerOptions {
  /** desktop.json in the user data folder. */
  stateFile: string;
  /** Where "Demo ansehen" keeps its copy of the demo. */
  demoRoot: string;
  /** Where new books go by default (the Documents folder). */
  booksHome: string;
  /** The built UI. */
  dist: string;
  /** The demo shipped with the app. */
  demoSource?: string;
  /** After books were opened, from the start screen or the menu. */
  onOpen?: (books: KnownBooks) => void;
  /** How often the inbox is looked at for files that arrived (src/server/background.ts). */
  inboxEveryMs?: number;
}

export interface DesktopServer {
  app: express.Express;
  /** Opens the books in `root` and remembers them; throws a WorkspaceError when the folder holds none. */
  open(root: string): Promise<KnownBooks>;
  /** Copies the demo into the user data folder the first time, then opens the copy. */
  openDemo(): Promise<KnownBooks>;
  current(): KnownBooks | null;
  info(): DesktopInfo;
  /** Only requests to this host reach the books (a page elsewhere cannot rebind its name to this port). */
  allowHost(host: string): void;
  /**
   * From now on the inbox's arrivals start their runs and the schedule ticks, for whichever books
   * are open (src/server/background.ts); called once the claude CLI is known, which the runs use.
   */
  startBackground(): void;
  /** The phone's listener: switched on or off (kept for the next start), a new token, its state. */
  phone: {
    set(on: boolean): Promise<PhoneInfo>;
    renew(): PhoneInfo;
    info(): PhoneInfo;
    /** At start: listens again when it was on. */
    resume(): Promise<PhoneInfo>;
  };
}

/** Listens on `host`, on `preferred` when it is free, else on a port the system chooses. */
export function listen(handler: RequestListener, host: string, preferred: number | undefined): Promise<Server> {
  const attempt = (port: number) => new Promise<Server>((resolve, reject) => {
    const s = createServer(handler);
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });
  return preferred ? attempt(preferred).catch(() => attempt(0)) : attempt(0);
}

export const portOf = (s: Server) => (s.address() as { port: number }).port;

export function desktopServer(opts: DesktopServerOptions): DesktopServer {
  let books: express.Express | undefined;
  let open: KnownBooks | null = null;
  let host: string | undefined;
  let background: 'off' | 'wanted' | 'running' = 'off';
  const runBackground = async () => {
    if (background !== 'wanted' || !books) return;
    background = 'running';
    (await import('../server/background.js')).startBackground({ inboxEveryMs: opts.inboxEveryMs });
  };

  const known = (root: string): KnownBooks => {
    const demo = resolve(root) === resolve(opts.demoRoot);
    try { return { root, name: workspaceAt(root).company.name, demo }; } catch { return { root, demo }; }
  };

  async function openBooks(root: string): Promise<KnownBooks> {
    root = resolve(root);
    if (!appFolderIn(root)) throw new WorkspaceError(`${root}: no ${MANIFEST_FILE}, here or in its ${APP_FOLDER}/.`);
    workspaceAt(root);
    if (books) (await import('../server/books.js')).reopenWorkspace(root);
    else {
      openWorkspaceAt(root);
      books = (await import('../server/api.js')).app;
    }
    writeState(opts.stateFile, opened(readState(opts.stateFile), root));
    await runBackground();
    open = known(root);
    opts.onOpen?.(open);
    return open;
  }

  async function openDemo(): Promise<KnownBooks> {
    if (!appFolderIn(opts.demoRoot)) copyTree(opts.demoSource ?? join(APP_ROOT, 'demo'), opts.demoRoot);
    return openBooks(opts.demoRoot);
  }

  // ─── The phone ─────────────────────────────────────────────────────────────
  let pairing: PhonePairing | undefined = readState(opts.stateFile).phone;
  let lan: Server | undefined;
  let lanError: string | undefined;
  const keep = (p: PhonePairing) => { pairing = p; writeState(opts.stateFile, { ...readState(opts.stateFile), phone: p }); };
  const token = () => (pairing?.on && lan ? pairing.token : undefined);
  // The books API checks the same token (src/server/phone.ts phoneGate).
  usePhoneToken(token);
  const noBooks = (_req: express.Request, res: express.Response) => {
    res.status(409).json({ error: 'Keine Buchhaltung geöffnet.', code: 'noWorkspace' } satisfies ApiErrorBody);
  };
  const toBooks = phoneApp((req, res, next) => (books ? books(req, res, next) : noBooks(req, res)), token);

  const phoneInfo = (): PhoneInfo => {
    const addresses = lanAddresses();
    const on = !!(pairing?.on && lan);
    const url = on && addresses[0] ? pairingUrl(addresses[0], pairing!.port!, pairing!.token) : undefined;
    return { on, addresses, ...(pairing?.port ? { port: pairing.port } : {}), ...(url ? { url, qr: qrSvg(url) } : {}), ...(lanError ? { error: lanError } : {}) };
  };
  async function setPhone(on: boolean): Promise<PhoneInfo> {
    lanError = undefined;
    if (!on) {
      const closing = lan;
      lan = undefined;
      if (closing) await new Promise<void>((done) => { closing.close(() => done()); closing.closeAllConnections(); });
      if (pairing) keep({ ...pairing, on: false });
      return phoneInfo();
    }
    const tok = pairing?.token ?? newPhoneToken();
    if (!lan) {
      try {
        // Every interface: the phone comes over Wi-Fi, Ethernet or the iPhone's USB hotspot.
        lan = await listen(toBooks, '0.0.0.0', pairing?.port);
      } catch (e) {
        lanError = (e as Error).message;
        keep({ token: tok, on: false, ...(pairing?.port ? { port: pairing.port } : {}) });
        return phoneInfo();
      }
    }
    keep({ on: true, token: tok, port: portOf(lan) });
    return phoneInfo();
  }

  const info = (): DesktopInfo => ({
    open,
    recent: readState(opts.stateFile).recent.map(known),
    booksHome: opts.booksHome,
  });

  const app = express();
  app.use((req, res, next) => {
    if (!host || req.headers.host === host) return next();
    res.status(403).json({ error: 'Nur von diesem Computer aus erreichbar.', code: 'localOnly' } satisfies ApiErrorBody);
  });
  app.use('/api/desktop', express.json());
  app.get('/api/desktop', (_req, res) => { res.json(info()); });
  app.post('/api/desktop/open', async (req, res) => {
    const root = (req.body as { root?: unknown }).root;
    if (typeof root !== 'string' || !root.trim()) return refuse(res, new WorkspaceError('No folder given.'));
    try { res.json(await openBooks(root)); } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/create', async (req, res) => {
    try {
      const created = await createWorkspace(req.body as SetupRequest);
      res.json(await openBooks(created.root));
    } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/demo', async (_req, res) => {
    try { res.json(await openDemo()); } catch (e) { refuse(res, e); }
  });
  app.get('/api/desktop/phone', (_req, res) => { res.json(phoneInfo()); });
  app.post('/api/desktop/phone', async (req, res) => {
    const { on, renew } = (req.body ?? {}) as { on?: unknown; renew?: unknown };
    if (renew === true) {
      keep({ on: pairing?.on ?? false, token: newPhoneToken(), ...(pairing?.port ? { port: pairing.port } : {}) });
      res.json(phoneInfo());
      return;
    }
    if (typeof on !== 'boolean') { res.status(400).json({ error: 'on (true oder false) oder renew ist nötig.' }); return; }
    res.json(await setPhone(on));
  });

  app.use(express.static(opts.dist, { index: false }));
  app.use((req, res, next) => (books ? books(req, res, next) : next()));
  app.get(/.*/, (req, res, next) => (isAppPath(req.path) ? res.sendFile(join(opts.dist, 'index.html')) : next()));
  app.use('/api', (_req, res) => {
    res.status(409).json({ error: 'Keine Buchhaltung geöffnet.', code: 'noWorkspace' } satisfies ApiErrorBody);
  });

  return {
    app, open: openBooks, openDemo, info,
    current: () => open,
    allowHost: (h) => { host = h; },
    startBackground: () => { if (background === 'off') { background = 'wanted'; void runBackground(); } },
    phone: {
      set: setPhone,
      renew: () => { keep({ on: pairing?.on ?? false, token: newPhoneToken(), ...(pairing?.port ? { port: pairing.port } : {}) }); return phoneInfo(); },
      info: phoneInfo,
      resume: () => (pairing?.on ? setPhone(true) : Promise.resolve(phoneInfo())),
    },
  };
}

function refuse(res: express.Response, e: unknown): void {
  if (e instanceof SetupError) res.status(400).json({ error: e.message, code: 'setup', params: e.refusal } satisfies ApiErrorBody);
  else if (e instanceof WorkspaceError) res.status(400).json({ error: e.message, code: 'notWorkspace' } satisfies ApiErrorBody);
  else res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

/** Copied file by file with the calls Electron reads its asar archive with (readdir, readFile): the demo lies inside it. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) writeFileSync(dst, readFileSync(src));
  }
}
