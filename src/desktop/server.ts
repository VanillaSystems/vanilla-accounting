/**
 * The desktop app's local server: the start screen's routes under /api/desktop, the built UI, and
 * the books API (src/server/api.ts) once a workspace is open. The books API is imported only then,
 * because it opens its workspace as it loads; another workspace later is switched in place.
 * Nothing here needs Electron, so the tests run it in Node.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { isAppPath } from '../server/app-paths.js';
import { SetupError, createWorkspace, type SetupRequest } from '../workspace/create.js';
import { APP_ROOT, MANIFEST_FILE, WorkspaceError, openWorkspaceAt, workspaceAt } from '../workspace/workspace.js';
import type { ApiErrorBody } from '../types/api-error.js';
import type { DesktopInfo, KnownBooks } from '../types/desktop.js';
import { opened, readState, writeState } from './state.js';

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
}

export function desktopServer(opts: DesktopServerOptions): DesktopServer {
  let books: express.Express | undefined;
  let open: KnownBooks | null = null;
  let host: string | undefined;

  const known = (root: string): KnownBooks => {
    const demo = resolve(root) === resolve(opts.demoRoot);
    try { return { root, name: workspaceAt(root).company.name, demo }; } catch { return { root, demo }; }
  };

  async function openBooks(root: string): Promise<KnownBooks> {
    root = resolve(root);
    if (!existsSync(join(root, MANIFEST_FILE))) throw new WorkspaceError(`${root}: no ${MANIFEST_FILE}.`);
    workspaceAt(root);
    if (books) (await import('../server/books.js')).reopenWorkspace(root);
    else {
      openWorkspaceAt(root);
      books = (await import('../server/api.js')).app;
    }
    writeState(opts.stateFile, opened(readState(opts.stateFile), root));
    open = known(root);
    opts.onOpen?.(open);
    return open;
  }

  async function openDemo(): Promise<KnownBooks> {
    if (!existsSync(join(opts.demoRoot, MANIFEST_FILE))) copyTree(opts.demoSource ?? join(APP_ROOT, 'demo'), opts.demoRoot);
    return openBooks(opts.demoRoot);
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
