/**
 * «Im Terminal öffnen» (issue #146): which terminal CLIs this computer has, the one chosen in
 * Firma › KI, and opening one in the books folder with the sidebar's request. Answers only to this
 * computer (src/server/api.ts); the open takes a JSON body, which a page of another site cannot
 * send without the browser asking first.
 */
import { join } from 'node:path';
import { Router } from 'express';
import { WS, patchBody, RequestError } from '../books.js';
import { readSettings } from '../../llm/settings.js';
import { chooseCli, isTerminalCli, type TerminalView } from '../../platform/terminal.js';
import { detectClis, openInTerminal, stateOf, terminalPath } from '../../platform/terminal-open.js';
import { ensureTerminalAgents } from '../../workspace/terminal-agents.js';

export const router = Router();

async function found() {
  return detectClis({ path: await terminalPath(), ledger: join(WS.paths.data, 'llm-ledger.jsonl'), claudeBin: process.env.CLAUDE_BIN });
}

async function view(): Promise<TerminalView> {
  const preferred = readSettings().cli;
  return { clis: (await found()).map(stateOf), ...(preferred ? { preferred } : {}), opens: process.platform === 'darwin', folder: WS.paths.root };
}

router.get('/api/terminal', async (_req, res) => {
  res.json(await view());
});

router.post('/api/terminal/open', async (req, res) => {
  const { request, cli } = patchBody(req.body, ['request', 'cli']);
  if (typeof request !== 'string' || !request.trim()) throw new RequestError(400, 'request: der Auftrag fürs Terminal.');
  if (cli !== undefined && !isTerminalCli(cli)) throw new RequestError(400, 'cli: claude oder codex.');
  if (process.platform !== 'darwin') throw new RequestError(409, 'Das Terminal öffnet die App nur auf dem Mac: kopier den Befehl.', { code: 'terminalNotMac' });
  const clis = await found();
  const plan = chooseCli(clis.map(stateOf), cli ?? readSettings().cli);
  const chosen = plan.kind === 'open' ? clis.find((c) => c.cli === (cli ?? plan.cli)) : undefined;
  if (!chosen?.bin) throw new RequestError(409, 'Weder Claude Code noch Codex ist auf diesem Mac installiert.', { code: 'terminalNoCli' });
  // The terminal AI reads its rules there before anything else: written now, as this version writes them.
  ensureTerminalAgents(WS.paths);
  await openInTerminal(WS.paths.root, chosen.bin, request);
  res.json({ cli: chosen.cli });
});
