/**
 * The desktop app's local server: the start screen's routes under /api/desktop, the built UI, and
 * the books API (src/server/api.ts) once a workspace is open. The books API is imported only then,
 * because it opens its workspace as it loads; another workspace later is switched in place.
 * Switched on in Firma › Handy, a second listener on the local network takes the phone's paths
 * only, with the pairing token (src/server/phone.ts); it is off until then.
 * Nothing here needs Electron, so the tests run it in Node.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer, request, type RequestListener, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import express from 'express';
import { isApiPath, isAppPath } from '../server/app-paths.js';
import { lanAddresses, newPhoneToken, pairingUrl, phoneApp, refuseForeignHost, usePhoneToken } from '../server/phone.js';
import { SetupError, createWorkspace, type SetupRequest } from '../workspace/create.js';
import { readManifest } from '../workspace/manifest.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, WorkspaceError, WorkspaceRefusal, appFolderIn, openWorkspaceAt, workspaceAt } from '../workspace/workspace.js';
import { bundledDemo, nameDemoCopy } from '../workspace/demo-copy.js';
import { assumedOf, parseAssumed, stillAssumed } from '../onboarding/model.js';
import { withLater } from '../workspace/setup.js';
import { seedAssumed } from '../onboarding/store.js';
import { beginDraft, createFromDraft, draftView, patchDraft, readDraft } from '../onboarding/draft-store.js';
import type { SetupBegun, SetupDraftView } from '../onboarding/draft.js';
import { MAX_TEXT, parseTalkRequest, talkDraft, type Ask, type SetupTalked } from '../onboarding/draft-talk.js';
import { isOldLayout } from '../workspace/layout.js';
import { upgradeWorkspace } from '../workspace/upgrade.js';
import { renewTerminalAgents } from '../workspace/terminal-agents.js';
import type { ApiErrorBody } from '../types/api-error.js';
import type { AiAvailability, DesktopInfo, KnownBooks, PhoneInfo, FolderLook } from '../types/desktop.js';
import { aiSetup } from '../server/ai-setup.js';
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
  /** Under `npm run desktop:dev` (tools/desktop/dev.mjs): the Vite dev server's origin, which answers every request that is no API instead of `dist`. */
  devUi?: string;
  /** The demo shipped with the app. */
  demoSource?: string;
  /** After books were opened, from the start screen or the menu. */
  onOpen?: (books: KnownBooks) => void;
  /** How often the inbox is looked at for files that arrived (src/server/background.ts). */
  inboxEveryMs?: number;
  /** How long GET /api/desktop waits for the listing of booksHome before it answers without it (default 300 ms). */
  foldersWaitMs?: number;
  /** Lists booksHome's folders (a test holds it as macOS does while it asks); by default foldersIn. */
  listFolders?: (dir: string) => Promise<string[]>;
  /** Whether an AI provider answers on this computer (the setup conversation needs one); by default the providers of src/llm are asked. */
  aiAvailable?: () => Promise<boolean>;
  /** The model the setup conversation's typed words go to (src/onboarding/draft-talk.ts); by default src/llm's `ask`, the step's configured provider. */
  ask?: Ask;
}

/** Whether the app's steps can ask an AI here: the same rule as src/llm/ask.ts modelReady (#175). */
async function anyProviderReady(): Promise<boolean> {
  const { modelReady } = await import('../llm/ask.js');
  return modelReady(8000).catch(() => false);
}

export interface DesktopServer {
  app: express.Express;
  /**
   * Opens the books in `root` and remembers them; a folder with a setup broken off is remembered and
   * answered with `setup` (the start screen continues it); throws a WorkspaceError when it holds neither.
   */
  open(root: string): Promise<KnownBooks>;
  /** Copies the demo into the user data folder the first time, then opens the copy. */
  openDemo(): Promise<KnownBooks>;
  current(): KnownBooks | null;
  /**
   * What the start screen shows. Asynchronous: listing the Documents folder makes macOS ask the
   * person first, and while the question is open the read waits; off the main thread, the app and
   * its window go on meanwhile.
   */
  info(): Promise<DesktopInfo>;
  /** The books this Mac opened lately, for the menu: nothing in the Documents folder is listed. */
  recent(): KnownBooks[];
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
  // The books API tells a demo by where it lies (GET /api/workspace `demo`).
  nameDemoCopy(opts.demoRoot);
  const runBackground = async () => {
    if (background !== 'wanted' || !books) return;
    background = 'running';
    (await import('../server/background.js')).startBackground({ inboxEveryMs: opts.inboxEveryMs });
  };

  const known = (root: string): KnownBooks => {
    const demo = resolve(root) === resolve(opts.demoRoot);
    if (!existsSync(root)) return { root, demo };
    // A setup broken off before its books exist: no manifest yet, the draft names the firm.
    const draft = appFolderIn(root) ? undefined : readDraft(root);
    if (draft) return { root, ...(draft.firm ? { name: draft.firm.name } : {}), demo, setup: true };
    // A look at the name, never workspaceAt: that would switch the engines to these books' setup while other books are open.
    try { return { root, name: readManifest(join(appFolderIn(root) ?? root, MANIFEST_FILE)).company.name, demo }; } catch (e) { return { root, demo, problem: e instanceof Error ? e.message : String(e) }; }
  };

  const lookAt = (root: string): FolderLook => {
    const k = known(root);
    if (k.setup) return { holds: 'setup', ...(k.name ? { name: k.name } : {}) };
    if (k.name) return { holds: 'books', name: k.name };
    // Unreadable counts as taken: nothing new is written into a folder the app cannot see into.
    let names: string[];
    try { names = readdirSync(root); } catch (e) { return { holds: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'nothing' : 'files' }; }
    // The Finder's own file is no content.
    return { holds: names.some((n) => n !== '.DS_Store') ? 'files' : 'nothing' };
  };

  /** The demo copy as this version reads it: one from an app before 0.4.0 (books.json at its top) is thrown away, it is a copy. */
  const freshDemoCopy = () => {
    if (isOldLayout(opts.demoRoot)) rmSync(opts.demoRoot, { recursive: true, force: true });
    if (!appFolderIn(opts.demoRoot)) copyTree(opts.demoSource ?? join(APP_ROOT, 'demo'), opts.demoRoot);
  };
  const remember = (root: string) => writeState(opts.stateFile, opened(readState(opts.stateFile), root));

  async function openBooks(root: string): Promise<KnownBooks> {
    root = resolve(root);
    if (bundledDemo(root)) return openDemo();
    if (root === resolve(opts.demoRoot)) freshDemoCopy();
    const folder = appFolderIn(root);
    if (!folder) {
      if (!readDraft(root)) throw new WorkspaceError(`${root}: no ${MANIFEST_FILE}, here or in its ${APP_FOLDER}/.`);
      remember(root);
      return known(root);
    }
    if (isOldLayout(folder)) throw new WorkspaceRefusal(`${root} holds the books in the layout before 0.4.0 (books.json).`, { code: 'oldLayout', params: { root } });
    const ws = workspaceAt(root);
    // The packed app has no `npm run update`: opening is where a new version renews the AI's instructions.
    try { await renewTerminalAgents(ws.paths); } catch (e) { console.warn(`${root}: AGENTS.md not renewed: ${(e as Error).message}`); }
    if (books) (await import('../server/books.js')).reopenWorkspace(root);
    else {
      openWorkspaceAt(root);
      books = (await import('../server/api.js')).app;
    }
    remember(root);
    await runBackground();
    open = known(root);
    opts.onOpen?.(open);
    return open;
  }

  const openDemo = (): Promise<KnownBooks> => openBooks(opts.demoRoot);

  /**
   * Books in the layout before 0.4.0, moved into vanilla-accounting/ and split by year as
   * `npm run update` does it (src/workspace/upgrade.ts: books.json stays as a backup in
   * data/backups/, no record changes, the seals hold), then opened.
   */
  async function upgradeBooks(root: string): Promise<KnownBooks> {
    root = resolve(root);
    const folder = appFolderIn(root);
    if (!folder) throw new WorkspaceError(`${root}: no ${MANIFEST_FILE}, here or in its ${APP_FOLDER}/.`);
    await upgradeWorkspace(workspaceAt(folder));
    return openBooks(root);
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

  const recent = () => readState(opts.stateFile).recent.map(known);
  /** The newest listing of booksHome, and the one under way (macOS may hold it while it asks). */
  let listed: string[] | undefined;
  let listing: Promise<string[]> | undefined;
  const listFolders = () => (listing ??= (opts.listFolders ?? foldersIn)(opts.booksHome).then((f) => { listed = f; listing = undefined; return f; }));
  const info = async (): Promise<DesktopInfo> => ({ open, recent: recent(), booksHome: opts.booksHome, folders: await listFolders() });
  /**
   * GET /api/desktop: answered without waiting for a listing macOS holds (the question about the
   * Documents folder), so the first screen is not blank meanwhile; `foldersPending` then says the
   * folders follow from GET /api/desktop/folders.
   */
  const infoNow = async (): Promise<DesktopInfo> => {
    const folders = await Promise.race([listFolders(), new Promise<undefined>((r) => setTimeout(r, opts.foldersWaitMs ?? 300))]);
    return { open, recent: recent(), booksHome: opts.booksHome, folders: folders ?? listed ?? [], ...(folders ? {} : { foldersPending: true }) };
  };

  const app = express();
  app.use((req, res, next) => {
    if (!host || req.headers.host === host) return next();
    refuseForeignHost(res);
  });
  app.use('/api/desktop', express.json());
  // This Mac's AI (docs/0.4.0/ai-setup.md): before any books exist, and the same while books are open.
  app.use(aiSetup);
  app.get('/api/desktop', (_req, res, next) => { infoNow().then((i) => res.json(i), next); });
  app.get('/api/desktop/folders', (_req, res, next) => { listFolders().then((folders) => res.json({ folders }), next); });
  app.post('/api/desktop/open', async (req, res) => {
    const root = (req.body as { root?: unknown }).root;
    if (typeof root !== 'string' || !root.trim()) return refuse(res, new WorkspaceError('No folder given.'));
    try { res.json(await openBooks(root)); } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/create', async (req, res) => {
    try {
      const body = req.body as SetupRequest & { assumed?: unknown };
      const created = await createWorkspace(body);
      // What the kind of firm answered and she never touched (#385): kept only where the books took it.
      // The answers the setup does not ask (#452) took their `later` answer: assumed too, so the books show them to check.
      if (!created.existed) {
        const said = parseAssumed(body.assumed);
        const { answers, filled } = withLater(body.answers);
        seedAssumed(workspaceAt(created.root), assumedOf([...stillAssumed(said, answers).map((a) => a.key), ...filled], answers, said?.by));
      }
      res.json(await openBooks(created.root));
    } catch (e) { refuse(res, e); }
  });
  // The setup conversation before the books exist (src/onboarding/draft.ts, #139).
  app.get('/api/desktop/ai', async (_req, res) => {
    const { aiOff } = await import('../llm/off.js');
    const off = aiOff();
    res.json({ available: !off && await (opts.aiAvailable ?? anyProviderReady)(), ...(off ? { off } : {}) } satisfies AiAvailability);
  });
  const rootOf = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw.trim()) throw new SetupError('A folder for the books is needed.', { reason: 'required', field: 'root' });
    return resolve(raw);
  };
  const viewOf = (root: string): SetupDraftView => {
    const draft = readDraft(root);
    if (!draft) throw new SetupError('No setup in this folder.', { reason: 'required', field: 'root' });
    return draftView(root, draft);
  };
  // What a folder named for new books already holds, so the page never goes on silently in one that is not new.
  app.get('/api/desktop/folder', (req, res) => {
    try { res.json(lookAt(rootOf(req.query.root))); } catch (e) { refuse(res, e); }
  });
  app.get('/api/desktop/setup', (req, res) => {
    try { res.json(viewOf(rootOf(req.query.root))); } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/setup', async (req, res) => {
    try {
      const { root: raw, language } = (req.body ?? {}) as { root?: unknown; language?: unknown };
      const root = rootOf(raw);
      if (appFolderIn(root)) { res.json({ kind: 'books', books: await openBooks(root) } satisfies SetupBegun); return; }
      const draft = beginDraft(root, typeof language === 'string' ? language : 'de', new Date().toISOString());
      remember(root);
      res.json({ kind: 'draft', view: draftView(root, draft) } satisfies SetupBegun);
    } catch (e) { refuse(res, e); }
  });
  app.put('/api/desktop/setup', (req, res) => {
    try {
      const { root: raw, patch } = (req.body ?? {}) as { root?: unknown; patch?: unknown };
      const root = rootOf(raw);
      res.json(draftView(root, patchDraft(root, patch)));
    } catch (e) { refuse(res, e); }
  });
  // Words typed in the setup conversation (#145): read by the AI, checked and saved by code.
  app.post('/api/desktop/setup/talk', async (req, res) => {
    try {
      const root = rootOf((req.body ?? {}).root);
      const message = parseTalkRequest(req.body);
      if (!message) { res.status(400).json({ error: 'A message is needed.' } satisfies ApiErrorBody); return; }
      if ('tooLong' in message) { res.status(400).json({ error: `A message has at most ${MAX_TEXT} characters.` } satisfies ApiErrorBody); return; }
      const ask = opts.ask ?? (await import('../llm/ask.js')).ask;
      const { draft, reply } = await talkDraft(root, message.text, ask);
      res.json({ view: draftView(root, draft), reply } satisfies SetupTalked);
    } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/setup/create', async (req, res) => {
    try {
      const created = await createFromDraft(rootOf((req.body ?? {}).root), new Date().toISOString());
      res.json(await openBooks(created.root));
    } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/demo', async (_req, res) => {
    try { res.json(await openDemo()); } catch (e) { refuse(res, e); }
  });
  app.post('/api/desktop/upgrade', async (req, res) => {
    const root = (req.body as { root?: unknown }).root;
    if (typeof root !== 'string' || !root.trim()) return refuse(res, new WorkspaceError('No folder given.'));
    try { res.json(await upgradeBooks(root)); } catch (e) { refuse(res, e); }
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

  if (opts.devUi) {
    // Before the books' API: it serves the checkout's own dist folder (src/server/files.ts), a stale build under desktop:dev.
    app.use((req, res, next) => (isApiPath(req.path) ? next() : forwardTo(opts.devUi!, req, res)));
    app.use((req, res, next) => (books ? books(req, res, next) : next()));
  } else {
    // The page is this server's `dist`, before the books' API: that router also serves the checkout's own
    // dist folder (src/server/files.ts), which in a checkout that holds an older build is a stale page.
    app.use(express.static(opts.dist, { index: false }));
    app.get(/.*/, (req, res, next) => (isAppPath(req.path) ? res.sendFile('index.html', { root: opts.dist }) : next()));
    app.use((req, res, next) => (books ? books(req, res, next) : next()));
  }
  app.use('/api', (_req, res) => {
    res.status(409).json({ error: 'Keine Buchhaltung geöffnet.', code: 'noWorkspace' } satisfies ApiErrorBody);
  });

  return {
    app, open: openBooks, openDemo, info, recent,
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

/** The page and its modules from Vite, so the window keeps this server's origin, host check and API. Vite's HMR socket goes to Vite itself. */
function forwardTo(origin: string, req: express.Request, res: express.Response): void {
  const target = new URL(origin);
  const upstream = request({ hostname: target.hostname, port: target.port, path: req.originalUrl, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', (e) => { if (res.headersSent) res.end(); else res.status(502).type('text').send(`Vite at ${origin}: ${e.message}`); });
  req.pipe(upstream);
}

function refuse(res: express.Response, e: unknown): void {
  if (e instanceof SetupError) res.status(400).json({ error: e.message, code: 'setup', params: e.refusal } satisfies ApiErrorBody);
  else if (e instanceof WorkspaceRefusal) res.status(400).json({ error: e.message, ...e.refusal } satisfies ApiErrorBody);
  else if (e instanceof WorkspaceError) res.status(400).json({ error: e.message, code: 'notWorkspace' } satisfies ApiErrorBody);
  else res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

/**
 * The folders in `dir`; none when it is missing or may not be read. macOS asks the person before
 * the app reads the Documents folder: «Nicht erlauben» is an answer, never the end of the start.
 * Read off the main thread (fs/promises): a synchronous read held the main process for as long as
 * the question was open, and the first window's page then failed to load (issue #363).
 */
async function foldersIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    // Missing or refused is an answer; anything else is worth a line in the log.
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) console.error(`folders in ${dir}:`, e);
    return [];
  }
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
