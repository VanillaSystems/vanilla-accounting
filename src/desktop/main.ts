/**
 * The desktop app's main process (ADR 0006, form 3): the local server on 127.0.0.1, one window on
 * the built UI, the native menu, the passwords in the keychain store, and the few things a page
 * cannot do itself (a folder dialog, links to the browser). Built by tools/desktop/build.mjs into out/desktop/main.mjs, which keeps the
 * bundle two folders below the app root, as src/workspace/workspace.ts finds APP_ROOT.
 */
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, screen, session, shell } from 'electron';
import type { Express } from 'express';
import { usePrintPages } from '../invoices/pdf.js';
import { sealedStore } from '../secrets/sealed-store.js';
import { useSecretStore } from '../secrets/secrets.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { MenuCommand } from '../types/desktop.js';
import { findClaude } from './claude.js';
import { languageOf, menuTemplate, textsIn } from './menu.js';
import { electronPage } from './print.js';
import { desktopServer } from './server.js';
import { readState, writeState, type Bounds } from './state.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// The sheet's text is laid out as puppeteer prints it (src/invoices/pdf.ts launches Chrome so).
app.commandLine.appendSwitch('font-render-hinting', 'none');

if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start(): Promise<void> {
  await app.whenReady();
  const stateFile = join(app.getPath('userData'), 'desktop.json');
  const { homepage } = appPackage();
  usePrintPages(electronPage);
  const claudeFound = findClaude().then((bin) => { if (bin) process.env.CLAUDE_BIN = bin; });
  let language = languageOf(app.getLocale());
  let win: BrowserWindow | undefined;

  const server = desktopServer({
    stateFile,
    demoRoot: join(app.getPath('userData'), 'Demo'),
    booksHome: app.getPath('documents'),
    dist: join(APP_ROOT, 'dist'),
    // The start screen opens books through the server; the menu's recent list follows.
    onOpen: () => refreshMenu(),
  });
  useSecretStore(sealedStore({ file: join(app.getPath('userData'), 'secrets.json'), cipher: safeStorage, books: () => server.current()?.root }));
  const port = await listen(server.app, readState(stateFile).port);
  writeState(stateFile, { ...readState(stateFile), port });
  server.allowHost(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  guard(base);

  const show = (path = '/') => {
    if (!win || win.isDestroyed()) win = createWindow(stateFile);
    void win.loadURL(base + path);
    win.show();
  };
  const opening = (open: () => Promise<unknown>) => async () => {
    try {
      await open();
      show();
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

  ipcMain.handle('desktop:chooseFolder', (_e, title: unknown) => chooseFolder(typeof title === 'string' ? title : ''));
  ipcMain.on('desktop:language', (_e, code: unknown) => {
    const next = languageOf(typeof code === 'string' ? code : undefined);
    if (next !== language) { language = next; refreshMenu(); }
  });
  const last = readState(stateFile).recent[0];
  if (last) await server.open(last).catch(() => undefined);
  refreshMenu();
  // The page starts the inbox job as it loads; the job checks for claude once, so it must be known by then.
  await claudeFound;
  show();
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('activate', () => { if (!win || win.isDestroyed()) show(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  void checkForUpdates();
}

function listen(app: Express, preferred: number | undefined): Promise<number> {
  const attempt = (port: number) => new Promise<Server>((resolve, reject) => {
    const s = createServer(app);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
  return (preferred ? attempt(preferred).catch(() => attempt(0)) : attempt(0))
    .then((s) => (s.address() as { port: number }).port);
}

function createWindow(stateFile: string): BrowserWindow {
  const saved = visible(readState(stateFile).bounds);
  const win = new BrowserWindow({
    ...(saved ?? { width: 1440, height: 900 }),
    minWidth: 900, minHeight: 600, show: false, title: 'Vanilla Accounting',
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (saved?.maximized) win.maximize();
  void win.webContents.setVisualZoomLevelLimits(1, 1);
  win.on('close', () => {
    writeState(stateFile, { ...readState(stateFile), bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  });
  return win;
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
