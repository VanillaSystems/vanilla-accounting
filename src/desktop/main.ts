/**
 * The desktop app's main process (ADR 0006, form 3): the local server on 127.0.0.1 (and, switched
 * on in Firma › Handy, the phone's listener on the local network), one window on
 * the built UI, the native menu, the passwords in the keychain store, and the few things a page
 * cannot do itself (a folder dialog, links to the browser). Built by tools/desktop/build.mjs into
 * out/desktop/main.mjs, which keeps the bundle two folders below the app root, as
 * src/workspace/workspace.ts finds APP_ROOT.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, safeStorage, screen, session, shell, systemPreferences } from 'electron';
import { usePrintPages } from '../invoices/pdf.js';
import { sealedStore } from '../secrets/sealed-store.js';
import { useSecretStore } from '../secrets/secrets.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { KnownBooks, MenuCommand, MicAccess } from '../types/desktop.js';
import type { ApiRefusal } from '../types/api-error.js';
import { setupPath } from '../app/desktop/bridge.js';
import { freshLoginPath } from '../platform/ai-cli.js';
import { ASK, PUSH, TELL } from './channels.js';
import { chosenFolder, newFolderPanel } from './new-folder.js';
import { sameOrigin, saveFile } from './save-file.js';
import { askingPath, bringUp, firstPage, offerMove, unaskedPath, windowLoader, type Waiting } from './start.js';
import { accessText } from '../app/desktop/access-text.js';
import { dictate, isLang } from './dictation.js';
import { languageOf, menuTemplate, textsIn } from './menu.js';
import { electronPage } from './print.js';
import { desktopServer, listen, portOf } from './server.js';
import { answerKey, developerIdOf } from './build-key.js';
import { appVersion } from '../version.js';
import { readState, writeState, type Bounds } from './state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** tools/desktop/smoke.mjs: the fused release build has no inspector, so the page reaches the menu (preload.ts). */
const SMOKE = app.commandLine.hasSwitch('vanilla-smoke');
const DEV = devMode();
// Before the single-instance lock, which lives in the user data folder: dev never meets the installed app's.
if (DEV) {
  app.setPath('userData', DEV.userData);
  // The runner restarts it with SIGTERM, which Chromium alone takes 20 s and more to act on; app.quit() takes a moment.
  process.on('SIGTERM', () => app.quit());
}
/** The chat's speech recognizer: next to the app's binary when packed, beside the bundle when run from the repo. */
const DICTATION = process.platform !== 'darwin' ? undefined
  : [join(dirname(process.execPath), 'vanilla-dictation'), join(HERE, 'vanilla-dictation')].find((f) => existsSync(f));

// The sheet's text is laid out as puppeteer prints it (src/invoices/pdf.ts launches Chrome so).
app.commandLine.appendSwitch('font-render-hinting', 'none');

if (!app.requestSingleInstanceLock()) app.quit();
// A start that fails says so and ends: never a running app without a window.
else void start().catch((e: unknown) => {
  dialog.showErrorBox(textsIn(languageOf(app.getLocale()))('desktop.startFailed'), e instanceof Error ? e.message : String(e));
  app.exit(1);
});

async function start(): Promise<void> {
  const stateFile = join(app.getPath('userData'), 'desktop.json');
  let win: BrowserWindow | undefined;
  /** The local server's address once it listens; until then there is no page to show. */
  let base: string | undefined;
  /** The newest window while it waits hidden for its first paint (bringUp). */
  let waiting: Waiting = { since: 0 };
  /** The newest window's loads (windowLoader): tried again for under 10 s when one fails. */
  let load: ReturnType<typeof windowLoader> | undefined;
  /** The start's first page is loaded; a later page that fails to load says so and ends nothing. */
  let started = false;
  const loadFailed = (reason: string, first: boolean) => {
    const t = textsIn(language);
    if (first) {
      dialog.showErrorBox(t('desktop.startFailed'), reason);
      app.exit(1);
      return;
    }
    void dialog.showMessageBox({ type: 'warning', message: t('desktop.loadFailed'), detail: reason });
  };
  const show = (path = '/') => {
    if (!base) return;
    const fresh = !win || win.isDestroyed();
    if (fresh) {
      const opened = (win = createWindow(stateFile));
      waiting = { since: Date.now() };
      // A new window appears once the page has painted, not as an empty frame.
      opened.once('ready-to-show', () => opened.show());
      load = windowLoader(opened, loadFailed);
    }
    void load!(base + path, !started);
    started = true;
    if (!fresh) win!.show();
  };
  // A second start, a click on the Dock icon, `open -a`: the window in front. Listening before the
  // first wait of the start, so a start that hangs later (books that do not open, a login shell
  // that does not answer) still gives the person a window.
  app.on('second-instance', () => bringUp(win, show, waiting));
  app.on('activate', () => bringUp(win, show, waiting));
  await app.whenReady();
  const { homepage } = appPackage();
  usePrintPages(electronPage);
  // The login shell's PATH for a CLI installed elsewhere than ~/.local/bin; every later look asks it again (src/platform/ai-cli.ts).
  const pathKnown = freshLoginPath();
  let language = languageOf(app.getLocale());
  // Moved: Electron quits this process and starts the app in the Applications folder; nothing more starts here.
  if (await offerApplicationsFolder(textsIn(language)) === 'moved') return;

  // The build macOS's answers about folders are kept for: an ad hoc signed build is a new app to macOS (#373).
  const developerId = app.isPackaged && process.platform === 'darwin' && await developerIdOf(join(dirname(process.execPath), '..', '..'));
  let phoneResumed = false;
  const server = desktopServer({
    stateFile,
    demoRoot: join(app.getPath('userData'), 'Demo'),
    booksHome: app.getPath('documents'),
    // Names only: Electron reads none of them. The first read under one makes macOS ask the person (#373).
    protectedFolders: {
      documents: app.getPath('documents'), desktop: app.getPath('desktop'), downloads: app.getPath('downloads'),
      icloud: join(app.getPath('home'), 'Library', 'Mobile Documents'), cloud: join(app.getPath('home'), 'Library', 'CloudStorage'), volumes: '/Volumes',
    },
    appVersion: answerKey({ packageVersion: app.getVersion(), build: appVersion(), builtAt: process.env.VANILLA_BUILT_AT, developerId }),
    dist: join(APP_ROOT, 'dist'),
    devUi: DEV?.ui,
    // The start screen opens books through the server; the menu's recent list follows.
    onOpen: () => {
      refreshMenu();
      // The phone's listener (macOS's firewall may ask about it) only once books are open, never before the first window (#373).
      if (phoneResumed) return;
      phoneResumed = true;
        },
  });
  useSecretStore(sealedStore({ file: join(app.getPath('userData'), 'secrets.json'), cipher: safeStorage, books: () => server.current()?.root }));
  const port = portOf(await listen(server.app, '127.0.0.1', readState(stateFile).port));
  writeState(stateFile, { ...readState(stateFile), port });
  server.allowHost(`127.0.0.1:${port}`);
  base = `http://127.0.0.1:${port}`;

  guard(base);

  /** Books open on their page; a folder whose setup was broken off continues it on the start screen. */
  const pathOf = (books: KnownBooks | undefined) => (books?.setup ? setupPath(books.root) : '/');
  const opening = (open: () => Promise<KnownBooks>) => async () => {
    try {
      show(pathOf(await open()));
    } catch (e) {
      const t = textsIn(language);
      const refusal = (e as { refusal?: ApiRefusal }).refusal;
      const detail = refusal?.code === 'folderRefused' ? accessText(t, refusal.params, refusal.params.root) : (e as Error).message;
      await dialog.showMessageBox({ type: 'warning', message: t('desktop.notWorkspace'), detail });
    }
  };
  /** The folder dialog; `home`: it starts in the home folder (she chose another folder than Documents). */
  const chooseFolder = async (title: string, home = false): Promise<string | null> => {
    const options = { title, ...(home ? { defaultPath: app.getPath('home') } : {}), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  /**
   * The save panel that names the folder of new books, in the Documents folder (the server's
   * booksHome), or in the home folder when she chose another place (`elsewhere`: Documents refused).
   */
  const chooseNewFolder = async (choice: unknown): Promise<string | null> => {
    const elsewhere = !!choice && typeof choice === 'object' && (choice as { elsewhere?: unknown }).elsewhere === true;
    const options = newFolderPanel(choice, app.getPath(elsewhere ? 'home' : 'documents'));
    return chosenFolder(win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options));
  };
  /** The start screen with the words before macOS's question, for books whose folder this version has no answer for (#373). */
  const unasked = (root: string) => unaskedPath(root, server.recent().find((b) => b.root === root)?.name ?? basename(root), server.folderOf(root));
  function refreshMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(language, server.recent(), {
      openBooks: async () => {
        const root = await chooseFolder(textsIn(language)('desktop.chooseOpen'));
        if (root) await opening(() => server.open(root))();
      },
      newBooks: () => show('/start?new'),
      demo: opening(() => server.openDemo()),
      openRecent: (root) => (server.answered(root) ? void opening(() => server.open(root))() : show(unasked(root))),
      command: (command: MenuCommand) => win?.webContents.send(PUSH.menu, command),
      docs: homepage ? () => void shell.openExternal(homepage) : undefined,
    }, !app.isPackaged)));
  }

  if (SMOKE) smokeHandles();
  ipcMain.handle(ASK.chooseFolder, (_e, title: unknown, at: unknown) => chooseFolder(typeof title === 'string' ? title : '', at === 'home'));
  ipcMain.handle(ASK.chooseNewFolder, (_e, choice: unknown) => chooseNewFolder(choice));
  ipcMain.handle(ASK.saveFile, async (e, url: unknown, name: unknown) => {
    const href = typeof url === 'string' ? sameOrigin(url, e.sender.getURL()) : undefined;
    if (!href) return false;
    return saveFile(href, typeof name === 'string' ? basename(name) : 'document.pdf', {
      ask: async (file) => {
        const options = { defaultPath: join(app.getPath('downloads'), file) };
        const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        return r.canceled || !r.filePath ? undefined : r.filePath;
      },
      read: async (u) => {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
      write: (path, bytes) => writeFile(path, bytes),
    });
  });
  dictationHandles();
  ipcMain.on(TELL.language, (_e, code: unknown) => {
    const next = languageOf(typeof code === 'string' ? code : undefined);
    if (next !== language) { language = next; refreshMenu(); }
  });
  refreshMenu();
  await pathKnown;
  server.startBackground();
  // The books opened last, read only after macOS answered for their folder; a first start reads none (#373).
  void firstPage({
    last: readState(stateFile).recent[0], reach: server.reach, answered: server.answered, unasked, open: server.open, current: server.current, pathOf, show,
    // While macOS asks, the start screen names the folder and the books as desktop.json keeps them.
    asking: (root) => askingPath(root, server.recent().find((b) => b.root === root)?.name ?? basename(root), server.folderOf(root)),
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  void checkForUpdates();
}

/**
 * Started from the download's window (the dmg) or the Downloads folder, the app is gone once the
 * dmg is ejected. Moved by the app itself, macOS does not ask about it a second time.
 */
function offerApplicationsFolder(t: ReturnType<typeof textsIn>): Promise<'moved' | 'stays'> {
  return offerMove({
    offered: app.isPackaged && !SMOKE && !app.isInApplicationsFolder(),
    ask: async () => (await dialog.showMessageBox({
      type: 'question', message: t('desktop.moveTitle'), detail: t('desktop.moveDetail'),
      buttons: [t('desktop.moveYes'), t('desktop.moveNo')], defaultId: 0, cancelId: 1,
    })).response === 0,
    move: () => app.moveToApplicationsFolder({ conflictHandler: () => true }),
    failed: async (reason) => { await dialog.showMessageBox({ type: 'warning', message: t('desktop.moveFailed'), detail: reason }); },
  });
}

/** One recognizer per dictation of a page, stopped by the page, or when the page goes away. */
function dictationHandles(): void {
  if (!DICTATION) return;
  const running = new Map<string, () => void>();
  ipcMain.on(TELL.dictationStart, (e, id: unknown, lang: unknown) => {
    const page = e.sender;
    const key = `${page.id}:${String(id)}`;
    if (typeof id !== 'string' || !isLang(lang) || running.has(key)) return;
    // A reload or a closed window leaves no page to stop it: the microphone goes off with the page.
    const gone = () => stop();
    const stop = dictate(DICTATION, lang, (event) => {
      if (event.kind === 'ended') {
        running.delete(key);
        page.off('destroyed', gone).off('did-navigate', gone);
      }
      if (!page.isDestroyed()) page.send(PUSH.dictationEvent, id, event);
    });
    running.set(key, stop);
    page.once('destroyed', gone).once('did-navigate', gone);
  });
  ipcMain.on(TELL.dictationStop, (e, id: unknown) => { running.get(`${e.sender.id}:${String(id)}`)?.(); });
  // Read only, asks nothing: the page says why macOS will ask before the first dictation (#373).
  ipcMain.handle(ASK.micAccess, (): MicAccess => systemPreferences.getMediaAccessStatus('microphone'));
}

function smokeHandles(): void {
  const menu = () => Menu.getApplicationMenu();
  ipcMain.handle(ASK.smokeMenu, () => ({
    file: menu()?.items[1]?.submenu?.items.map((i) => i.label) ?? [],
    recent: menu()?.getMenuItemById('recent')?.submenu?.items.map((i) => i.label) ?? [],
  }));
  ipcMain.handle(ASK.smokeClick, (_e, id: unknown) => {
    const item = typeof id === 'string' ? menu()?.getMenuItemById(id) : null;
    item?.click();
    return !!item;
  });
  ipcMain.on(TELL.smokeQuit, () => app.quit());
}

function createWindow(stateFile: string): BrowserWindow {
  const saved = visible(readState(stateFile).bounds);
  const win = new BrowserWindow({
    ...(saved ?? { width: 1440, height: 900 }),
    minWidth: 900, minHeight: 600, show: false, title: 'Vanilla Accounting',
    // The colour of tokens.css's page for the system's theme, so no white flashes before it paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    // On the Mac the page runs up to the top edge under the traffic lights; no title bar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : {}),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [...(SMOKE ? ['--vanilla-smoke'] : []), ...(DICTATION ? ['--vanilla-dictation'] : [])],
    },
  });
  if (saved?.maximized) win.maximize();
  if (DEV) markDev(win);
  void win.webContents.setVisualZoomLevelLimits(1, 1);
  win.on('close', () => {
    writeState(stateFile, { ...readState(stateFile), bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  });
  return win;
}

/**
 * `npm run desktop:dev` (tools/desktop/dev.mjs): the UI from Vite and a user data folder of its own,
 * both named by the runner. Never in the packed app, whatever its environment says.
 */
function devMode(): { ui: string; userData: string } | undefined {
  const { VANILLA_DEV_UI: ui, VANILLA_DEV_USER_DATA: userData } = process.env;
  return !app.isPackaged && ui && userData ? { ui, userData } : undefined;
}

/** DEV in the title, on the Dock icon and in the page's corner, so it is never taken for the installed app. */
function markDev(win: BrowserWindow): void {
  app.dock?.setBadge('DEV');
  win.on('page-title-updated', (e, title) => { e.preventDefault(); win.setTitle(`DEV · ${title}`); });
  win.webContents.on('dom-ready', () => {
    void win.webContents.insertCSS(`html::after { content: 'DEV'; position: fixed; left: 50%; top: 6px; transform: translateX(-50%); z-index: 2147483647;
      pointer-events: none; padding: 2px 8px; border-radius: 4px; font: 700 11px/1.4 system-ui; letter-spacing: .08em;
      background: var(--warn); color: var(--bg); }`);
  });
}

/** The saved bounds when they still lie on a screen (a display may have been unplugged). */
function visible(bounds: Bounds | undefined): Bounds | undefined {
  if (!bounds) return undefined;
  const area = screen.getDisplayMatching(bounds).workArea;
  const overlaps = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  return overlaps ? bounds : undefined;
}

/** Pages of the app stay in the app; every other link opens in the browser; no page gets a device permission. */
function guard(base: string): void {
  const external = (url: string) => { if (/^(https?|mailto):/.test(url)) void shell.openExternal(url); };
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${base}/`)) return { action: 'allow' };
      external(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (url.startsWith(`${base}/`)) return;
      e.preventDefault();
      external(url);
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

/** package.json: `homepage` (Help › Dokumentation, absent until the app has a public page) and `desktop.autoUpdate`. */
function appPackage(): { homepage?: string; desktop?: { autoUpdate?: boolean } } {
  return JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
}

/**
 * Updates from the GitHub releases, off until the releases are public: package.json's
 * `desktop.autoUpdate`, or VANILLA_AUTO_UPDATE=1 for a test.
 */
async function checkForUpdates(): Promise<void> {
  const pkg = appPackage();
  if (!app.isPackaged || !(pkg.desktop?.autoUpdate || process.env.VANILLA_AUTO_UPDATE === '1')) return;
  const { default: updater } = await import('electron-updater');
  await updater.autoUpdater.checkForUpdatesAndNotify().catch((e: unknown) => console.error('update check failed:', e));
}
