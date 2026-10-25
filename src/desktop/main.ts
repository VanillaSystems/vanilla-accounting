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
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, safeStorage, screen, session, shell } from 'electron';
import { usePrintPages } from '../invoices/pdf.js';
import { sealedStore } from '../secrets/sealed-store.js';
import { useSecretStore } from '../secrets/secrets.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { KnownBooks, MenuCommand } from '../types/desktop.js';
import { setupPath } from '../app/desktop/bridge.js';
import { freshLoginPath } from '../platform/ai-cli.js';
import { sameOrigin, saveFile } from './save-file.js';
import { dictate, isLang } from './dictation.js';
import { languageOf, menuTemplate, textsIn } from './menu.js';
import { electronPage } from './print.js';
import { desktopServer, listen, portOf } from './server.js';
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
else void start();

async function start(): Promise<void> {
  await app.whenReady();
  const stateFile = join(app.getPath('userData'), 'desktop.json');
  const { homepage } = appPackage();
  usePrintPages(electronPage);
  // The login shell's PATH for a CLI installed elsewhere than ~/.local/bin; every later look asks it again (src/platform/ai-cli.ts).
  const pathKnown = freshLoginPath();
  let language = languageOf(app.getLocale());
  let win: BrowserWindow | undefined;
  await offerApplicationsFolder(textsIn(language));

  const server = desktopServer({
    stateFile,
    demoRoot: join(app.getPath('userData'), 'Demo'),
    booksHome: app.getPath('documents'),
    dist: join(APP_ROOT, 'dist'),
    devUi: DEV?.ui,
    // The start screen opens books through the server; the menu's recent list follows.
    onOpen: () => refreshMenu(),
  });
  useSecretStore(sealedStore({ file: join(app.getPath('userData'), 'secrets.json'), cipher: safeStorage, books: () => server.current()?.root }));
  const port = portOf(await listen(server.app, '127.0.0.1', readState(stateFile).port));
  writeState(stateFile, { ...readState(stateFile), port });
  server.allowHost(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  guard(base);

  const show = (path = '/') => {
    const fresh = !win || win.isDestroyed();
    if (fresh) {
      const opened = (win = createWindow(stateFile));
      // A new window appears once the page has painted, not as an empty frame.
      opened.once('ready-to-show', () => opened.show());
    }
    void win!.loadURL(base + path);
    if (!fresh) win!.show();
  };
  /** Books open on their page; a folder whose setup was broken off continues it on the start screen. */
  const pathOf = (books: KnownBooks | undefined) => (books?.setup ? setupPath(books.root) : '/');
  const opening = (open: () => Promise<KnownBooks>) => async () => {
    try {
      show(pathOf(await open()));
    } catch (e) {
      const t = textsIn(language);
      await dialog.showMessageBox({ type: 'warning', message: t('desktop.notWorkspace'), detail: (e as Error).message });
    }
  };
  const chooseFolder = async (title: string): Promise<string | null> => {
    const options = { title, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  function refreshMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(language, server.info().recent, {
      openBooks: async () => {
        const root = await chooseFolder(textsIn(language)('desktop.chooseOpen'));
        if (root) await opening(() => server.open(root))();
      },
      newBooks: () => show('/start?new'),
      demo: opening(() => server.openDemo()),
      openRecent: (root) => void opening(() => server.open(root))(),
      command: (command: MenuCommand) => win?.webContents.send('desktop:menu', command),
      docs: homepage ? () => void shell.openExternal(homepage) : undefined,
    }, !app.isPackaged)));
  }

  if (SMOKE) smokeHandles();
  ipcMain.handle('desktop:chooseFolder', (_e, title: unknown) => chooseFolder(typeof title === 'string' ? title : ''));
  ipcMain.handle('desktop:saveFile', async (e, url: unknown, name: unknown) => {
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
  ipcMain.on('desktop:language', (_e, code: unknown) => {
    const next = languageOf(typeof code === 'string' ? code : undefined);
    if (next !== language) { language = next; refreshMenu(); }
  });
  const last = readState(stateFile).recent[0];
  const first = last ? await server.open(last).catch(() => undefined) : undefined;
  refreshMenu();
  await pathKnown;
  server.startBackground();
  void server.phone.resume().then((p) => { if (p.error) console.error(`phone: ${p.error}`); });
  show(pathOf(first));
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('activate', () => { if (!win || win.isDestroyed()) show(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  void checkForUpdates();
}

/**
 * Started from the download's window (the dmg) or the Downloads folder, the app is gone once the
 * dmg is ejected. Moved by the app itself, macOS does not ask about it a second time.
 */
async function offerApplicationsFolder(t: ReturnType<typeof textsIn>): Promise<void> {
  if (!app.isPackaged || SMOKE || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox({
    type: 'question', message: t('desktop.moveTitle'), detail: t('desktop.moveDetail'),
    buttons: [t('desktop.moveYes'), t('desktop.moveNo')], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder({ conflictHandler: () => true });
  } catch (e) {
    await dialog.showMessageBox({ type: 'warning', message: t('desktop.moveFailed'), detail: (e as Error).message });
  }
}

/** One recognizer per dictation of a page, stopped by the page, or when the page goes away. */
function dictationHandles(): void {
  if (!DICTATION) return;
  const running = new Map<string, () => void>();
  ipcMain.on('dictation:start', (e, id: unknown, lang: unknown) => {
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
      if (!page.isDestroyed()) page.send('dictation:event', id, event);
    });
    running.set(key, stop);
    page.once('destroyed', gone).once('did-navigate', gone);
  });
  ipcMain.on('dictation:stop', (e, id: unknown) => { running.get(`${e.sender.id}:${String(id)}`)?.(); });
}

function smokeHandles(): void {
  const menu = () => Menu.getApplicationMenu();
  ipcMain.handle('smoke:menu', () => ({
    file: menu()?.items[1]?.submenu?.items.map((i) => i.label) ?? [],
    recent: menu()?.getMenuItemById('recent')?.submenu?.items.map((i) => i.label) ?? [],
  }));
  ipcMain.handle('smoke:click', (_e, id: unknown) => {
    const item = typeof id === 'string' ? menu()?.getMenuItemById(id) : null;
    item?.click();
    return !!item;
  });
  ipcMain.on('smoke:quit', () => app.quit());
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
