/**
 * «Im Terminal öffnen» (issues #146, #210): which terminal CLIs and terminal apps this computer
 * has, the ones chosen in Firma › KI, and opening one in the books folder, with the sidebar's
 * request when the person wrote one and with no prompt otherwise. Answers only to this computer
 * (src/server/api.ts); the open takes a JSON body, which a page of another site cannot send without
 * the browser asking first.
 */
import { Router } from 'express';
import { WS, patchBody, RequestError } from '../books.js';
import { readSettings, writeTerminalApp } from '../../llm/settings.js';
import { gate } from '../../llm/off.js';
import { chooseCli, chooseTerminalApp, isTerminalApp, isTerminalCli, type TerminalView } from '../../platform/terminal.js';
import { detectClis, detectTerminalApps, openInTerminal, stateOf } from '../../platform/terminal-open.js';
import { ensureTerminalAgents } from '../../workspace/terminal-agents.js';

export const router = Router();

async function view(): Promise<TerminalView> {
  const { cli: preferred, terminalApp: app } = readSettings();
  return {
    clis: (await detectClis()).map(stateOf), ...(preferred ? { preferred } : {}),
    apps: detectTerminalApps(), ...(app ? { app } : {}),
    opens: process.platform === 'darwin', folder: WS.paths.root,
  };
}

router.get('/api/terminal', async (_req, res) => {
  res.json(await view());
});

/** The terminal app chosen on this Mac (the chat's question with «merken», or Firma › KI); null: asked again. */
router.put('/api/terminal/app', async (req, res) => {
  const { app } = patchBody(req.body, ['app']);
  if (app !== null && !isTerminalApp(app)) throw new RequestError(400, 'app: terminal, iterm, ghostty, warp oder null.');
  if (app && !detectTerminalApps().includes(app)) throw new RequestError(409, 'Dieses Terminal ist auf diesem Mac nicht installiert.', { code: 'terminalAppMissing' });
  writeTerminalApp(app);
  res.json(await view());
});

router.post('/api/terminal/open', async (req, res) => {
  gate();
  const { request, cli, app } = patchBody(req.body, ['request', 'cli', 'app']);
  if (request !== undefined && typeof request !== 'string') throw new RequestError(400, 'request: der Auftrag fürs Terminal, oder keiner.');
  if (cli !== undefined && !isTerminalCli(cli)) throw new RequestError(400, 'cli: claude oder codex.');
  if (app !== undefined && !isTerminalApp(app)) throw new RequestError(400, 'app: terminal, iterm, ghostty oder warp.');
  if (process.platform !== 'darwin') throw new RequestError(409, 'Das Terminal öffnet die App nur auf dem Mac: kopier den Befehl.', { code: 'terminalNotMac' });
  const settings = readSettings();
  const clis = await detectClis();
  const plan = chooseCli(clis.map(stateOf), cli ?? settings.cli);
  const chosen = plan.kind === 'open' ? clis.find((c) => c.cli === (cli ?? plan.cli)) : undefined;
  if (!chosen?.bin) throw new RequestError(409, 'Weder Claude Code noch Codex ist auf diesem Mac installiert.', { code: 'terminalNoCli' });
  const apps = detectTerminalApps();
  if (app && !apps.includes(app)) throw new RequestError(409, 'Dieses Terminal ist auf diesem Mac nicht installiert.', { code: 'terminalAppMissing' });
  // The UI asks among several before it opens; a caller that did not ask gets Terminal, as before #210.
  const terminal = chooseTerminalApp(apps, app ?? settings.terminalApp);
  const opened = app ?? (terminal.kind === 'open' ? terminal.app : 'terminal');
  // The terminal AI reads its rules there before anything else: written now, as this version writes them.
  ensureTerminalAgents(WS.paths);
  await openInTerminal({ folder: WS.paths.root, bin: chosen.bin, request, app: opened });
  res.json({ cli: chosen.cli, app: opened });
});
