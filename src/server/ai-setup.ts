/**
 * The AI setup on this Mac (docs/0.4.0/ai-setup.md), also before any books exist: what each CLI is
 * (looked for afresh on every call), opening Terminal with the vendor's installer or the CLI's
 * sign-in, the one test call, an API key kept before any books exist, and the choices kept on this
 * Mac. Mounted by the desktop server before the books (src/desktop/server.ts) and by the books API
 * for `npm start` (src/server/api.ts); it opens no workspace.
 */
import express, { type Request, type Response } from 'express';
import { languageOf, textsIn } from '../app/i18n/texts-in.js';
import { modelReady, sidebarAgent } from '../llm/ask.js';
import { keepKey, KeyNotKept } from '../llm/key-store.js';
import { isRateLimitSignal } from '../llm/adaptive-pool.js';
import { claudeCli } from '../llm/providers/claude-cli.js';
import { codexCli } from '../llm/providers/codex-cli.js';
import { forgetCli, keyOf } from '../llm/providers/index.js';
import { KEYED, keyedProvider } from '../llm/providers/keyed.js';
import { readSettings, writeCli, writeNoAi } from '../llm/settings.js';
import { CallFailed, type Provider } from '../llm/provider.js';
import { freshLoginPath, installScript, locate, loginScript, probeAll, type ScriptTexts } from '../platform/ai-cli.js';
import { SETUP_KEYS, isSetupKey, type AiSetupView, type KeySaved, type Probation } from '../platform/ai-setup.js';
import { openScript } from '../platform/terminal-open.js';
import { AI_CLIS, isTerminalCli, type TerminalCli } from '../platform/terminal.js';
import { secrets } from '../secrets/secrets.js';
import type { ApiErrorBody } from '../types/api-error.js';

export async function setupView(): Promise<AiSetupView> {
  const clis = await probeAll();
  forgetCli();
  const settings = readSettings();
  return {
    clis,
    keys: await Promise.all(SETUP_KEYS.map(async (id) => ({ id, set: !!(await keyOf(id)) }))),
    keysInApp: secrets.inApp(),
    noAi: settings.noAi === true,
    askOther: settings.askOther === true,
    ...(settings.cli ? { preferred: settings.cli } : {}),
    sidebar: sidebarAgent().provider.id === 'codex-cli' ? 'codex' : 'claude',
    opens: process.platform === 'darwin',
    available: await modelReady(8000),
  };
}

/** What a refused test call says: a used-up limit, a plan without the CLI, or something else, in the CLI's words. */
export function probationOf(said: string): Probation {
  const text = said.replace(/^(claude|codex) exited \S+: /, '').trim();
  if (isRateLimitSignal(text)) return { ok: false, why: 'limit', said: text };
  if (/subscription|plan\b|upgrade|not (available|included)|credit balance|billing/i.test(text)) return { ok: false, why: 'plan', said: text };
  return { ok: false, why: 'other', said: text };
}

const PROMPT = 'Antworte nur mit dem Wort: ok';

/** One call with the cheapest model (decision 2): the only check that sees a plan too small, a region not served or a limit reached. */
async function testCall(provider: Provider, model: string): Promise<Probation> {
  const started = Date.now();
  try {
    await provider.ask({ prompt: PROMPT, model, system: 'Answer with one word.', attachments: [], timeoutMs: 90_000 });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return probationOf(e instanceof CallFailed || e instanceof Error ? e.message : String(e));
  }
}

/** The Terminal screens' words in the person's language (src/platform/ai-cli.ts ScriptTexts). */
export function scriptTexts(lang: string, cli: TerminalCli): ScriptTexts {
  const t = textsIn(lang);
  const names = { cli: t(`terminal.cli.${cli}`), vendor: AI_CLIS[cli].vendor };
  return {
    title: t('aiSetup.script.title', names),
    steps: [t('aiSetup.script.step1', names), t('aiSetup.script.step2', names), t('aiSetup.script.step3')],
    runs: t('aiSetup.script.runs'),
    prompt: t('aiSetup.script.prompt'),
    working: t('aiSetup.script.working'),
    installed: t('aiSetup.script.installed', names),
    signInPrompt: t('aiSetup.script.signInPrompt'),
    done: t('aiSetup.script.done'),
    failed: t('aiSetup.script.failed'),
    signInFailed: t('aiSetup.script.signInFailed'),
    back: t('aiSetup.script.back'),
  };
}

const loginTexts = (lang: string, cli: TerminalCli) => {
  const t = textsIn(lang);
  const names = { cli: t(`terminal.cli.${cli}`), vendor: AI_CLIS[cli].vendor };
  return { ...scriptTexts(lang, cli), title: t('aiSetup.script.loginTitle', names), steps: [t('aiSetup.script.loginStep1', names), t('aiSetup.script.loginStep2'), t('aiSetup.script.step3')] as const };
};

const refuse = (res: Response, status: number, body: ApiErrorBody) => { res.status(status).json(body); };
const language = (req: Request) => languageOf(typeof req.body?.language === 'string' ? req.body.language : undefined);

export const aiSetup = express.Router();
aiSetup.use('/api/ai/setup', express.json());

aiSetup.get('/api/ai/setup', async (_req, res) => { res.json(await setupView()); });

/** Terminal opens with the vendor's installer written out; it runs only once the person presses Enter there. */
aiSetup.post('/api/ai/setup/:cli/install', async (req, res) => {
  const { cli } = req.params;
  if (!isTerminalCli(cli)) return refuse(res, 404, { error: `Kein Programm ${cli}.` });
  if (process.platform !== 'darwin') return refuse(res, 409, { error: 'Das Terminal öffnet die App nur auf dem Mac: kopier den Befehl.', code: 'terminalNotMac' });
  await openScript((dir) => installScript(cli, dir, scriptTexts(language(req), cli)));
  res.json({ ok: true });
});

/** Terminal opens with the CLI's own sign-in, which opens the vendor's page in the browser. */
aiSetup.post('/api/ai/setup/:cli/login', async (req, res) => {
  const { cli } = req.params;
  if (!isTerminalCli(cli)) return refuse(res, 404, { error: `Kein Programm ${cli}.` });
  if (process.platform !== 'darwin') return refuse(res, 409, { error: 'Das Terminal öffnet die App nur auf dem Mac: kopier den Befehl.', code: 'terminalNotMac' });
  const bin = locate(cli, { path: await freshLoginPath() });
  if (!bin) return refuse(res, 409, { error: `${cli} ist auf diesem Mac nicht installiert.`, code: 'terminalNoCli' });
  await openScript((dir) => loginScript(cli, bin, dir, loginTexts(language(req), cli)));
  res.json({ ok: true });
});

/** The provider each CLI's test call runs through: the one the app's steps ask. */
const PROVIDER_OF: Record<TerminalCli, Provider> = { claude: claudeCli, codex: codexCli };

aiSetup.post('/api/ai/setup/:cli/test', async (req, res) => {
  const { cli } = req.params;
  if (!isTerminalCli(cli)) return refuse(res, 404, { error: `Kein Programm ${cli}.` });
  const provider = PROVIDER_OF[cli];
  res.json(await testCall(provider, provider.defaults.fast));
});

/** A key checked by the provider, kept in this Mac's keychain store, then one test call with it; null removes it. */
aiSetup.put('/api/ai/setup/keys/:provider', async (req, res) => {
  const id = req.params.provider;
  if (!isSetupKey(id)) return refuse(res, 404, { error: `Kein Anbieter ${id}.` });
  const raw = (req.body ?? {}).key;
  if (raw !== null && (typeof raw !== 'string' || !raw.trim())) return refuse(res, 400, { error: 'key: ein Schlüssel, oder null zum Entfernen.' });
  const key = typeof raw === 'string' ? raw.trim() : null;
  try {
    await keepKey(id, key);
  } catch (e) {
    if (!(e instanceof KeyNotKept)) throw e;
    if (e.reason === 'where') return refuse(res, 409, { error: e.message, code: 'aiKeyWhere', params: { where: e.where! } });
    if (e.reason === 'refused') return refuse(res, 400, { error: e.message, code: 'aiKeyRefused' });
    return refuse(res, 503, { error: e.message, code: 'secretStore' });
  }
  const spec = KEYED.find((s) => s.id === id)!;
  const test = key ? await testCall(keyedProvider(spec, key, spec.shipped), spec.defaults.fast) : undefined;
  res.json({ view: await setupView(), ...(test ? { test } : {}) } satisfies KeySaved);
});

/** «Ohne KI weitermachen» (decision 6) and the option to ask the other CLI (decision 4), kept on this Mac. */
aiSetup.put('/api/ai/setup/choice', async (req, res) => {
  const { noAi, askOther } = (req.body ?? {}) as { noAi?: unknown; askOther?: unknown };
  if ((noAi !== undefined && typeof noAi !== 'boolean') || (askOther !== undefined && typeof askOther !== 'boolean')) {
    return refuse(res, 400, { error: 'noAi und askOther: true oder false.' });
  }
  if (noAi !== undefined) writeNoAi(noAi);
  if (askOther !== undefined) writeCli({ askOther });
  res.json(await setupView());
});
