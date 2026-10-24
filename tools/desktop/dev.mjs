/**
 * npm run desktop:dev: the Mac app from this checkout without a rebuild per change.
 *
 * The window keeps loading the desktop server (src/desktop/server.ts), which answers the API and
 * the bridge as in the packed app and hands every other request to the Vite dev server started
 * here, so a change under src/app shows at once through HMR. A change to a file the main process
 * bundles (src/desktop, src/server, the engine), outside src/app, rebuilds the bundle and restarts
 * Electron. Type `rs` and Enter to restart it by hand. Arguments after `--` go to Electron.
 *
 * Its user data folder is its own (VANILLA_DEV_USER_DATA, by default vanilla-accounting-dev next
 * to the installed app's), so the two run side by side and share no recent list, lock or demo copy.
 */
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { createServer as probe } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import electron from 'electron';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { describeBuild } from '../../src/version.ts';
import { bundles } from './bundles.mjs';

const VITE_PORT = 5191;
const WINDOW_PORT = 5192;
// An app opened from the Finder gets this PATH; claude and codex are then found through the login shell, as there.
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const userData = process.env.VANILLA_DEV_USER_DATA
  || join(homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config', 'vanilla-accounting-dev');
seedPort(join(userData, 'desktop.json'));

// Middleware mode: a Vite that listens itself exits this process on SIGTERM or the end of stdin, past the cleanup below.
const vitePort = await freePort(VITE_PORT);
const viteHttp = createHttpServer();
const vite = await createServer({ server: { middlewareMode: true, hmr: { server: viteHttp, host: '127.0.0.1', clientPort: vitePort } } });
viteHttp.on('request', vite.middlewares);
await new Promise((resolve) => viteHttp.listen(vitePort, '127.0.0.1', resolve));
const ui = `http://127.0.0.1:${vitePort}`;

const contexts = await Promise.all(bundles(describeBuild(process.cwd())).map((options) => context(options)));
let inputs = await rebuild();

let child;
let restarting = false;
let quitting = false;
startElectron();
console.log(`desktop:dev  UI ${ui} (HMR)  user data ${userData}  rs + Enter restarts`);

let changed = new Set();
let timer;
watch('src', { recursive: true }, (_event, file) => {
  if (!file) return;
  changed.add(join('src', file).split(sep).join('/'));
  clearTimeout(timer);
  timer = setTimeout(onChange, 150);
});
process.stdin.on('data', (d) => { if (d.toString().trim() === 'rs') void restart('by hand'); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void shutdown());
// Should this process end any other way, Electron does not outlive it.
process.on('exit', () => { if (alive(child)) signalGroup(child, 'SIGTERM'); });

/** Only files the main process bundles restart it; src/app is the page's, and Vite has it already. */
async function onChange() {
  const files = [...changed];
  changed = new Set();
  const main = files.filter((f) => inputs.has(f) && !f.startsWith('src/app/'));
  if (main.length) await restart(main.join(', '));
}

async function rebuild() {
  const results = await Promise.all(contexts.map((c) => c.rebuild()));
  return new Set(results.flatMap((r) => Object.keys(r.metafile.inputs)));
}

function startElectron() {
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  // The mock keychain: dev never reads or writes the installed app's "vanilla-accounting Safe Storage" item.
  // Its own process group: Electron, its helpers and the login shell it asks for PATH, ended together and nothing else.
  child = spawn(electron, ['.', '--use-mock-keychain', ...process.argv.slice(2)], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...env, PATH: FINDER_PATH, VANILLA_DEV_UI: ui, VANILLA_DEV_USER_DATA: userData },
  });
  const self = child;
  self.on('exit', () => {
    signalGroup(self, 'SIGKILL');
    if (child === self && !restarting) void shutdown();
  });
}

async function restart(why) {
  if (restarting || quitting) return;
  restarting = true;
  console.log(`desktop:dev  restart (${why})`);
  try {
    inputs = await rebuild();
    await stopElectron();
    startElectron();
  } catch (e) {
    console.error(`desktop:dev  the main process did not build, Electron keeps running: ${e.message}`);
  } finally {
    restarting = false;
  }
}

function alive(c) { return !!c && c.exitCode === null && c.signalCode === null; }
function signalGroup(c, signal) { try { process.kill(-c.pid, signal); } catch { /* already gone */ } }

/** Ends our own Electron: SIGTERM lets it quit, its process group is swept once it is gone (startElectron), SIGKILL to the group after 5 s. */
function stopElectron() {
  const running = child;
  if (!alive(running)) return Promise.resolve();
  return new Promise((done) => {
    const force = setTimeout(() => signalGroup(running, 'SIGKILL'), 5000);
    running.once('exit', () => { clearTimeout(force); done(); });
    running.kill('SIGTERM');
  });
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  clearTimeout(timer);
  await stopElectron();
  await Promise.all(contexts.map((c) => c.dispose()));
  await vite.close();
  viteHttp.close();
  process.exit(0);
}

/** The first free port from `from` on, so a second checkout's desktop:dev starts too. */
async function freePort(from) {
  for (let port = from; port < from + 50; port++) {
    const free = await new Promise((resolve) => {
      const s = probe().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port from ${from} on.`);
}

/** The window's port, chosen once: the page keeps theme, zoom and language per origin. */
function seedPort(file) {
  let state = {};
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* a first start */ }
  if (Number.isInteger(state.port)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ recent: [], ...state, port: WINDOW_PORT }, null, 2) + '\n', { mode: 0o600 });
}
