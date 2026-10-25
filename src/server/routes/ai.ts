/**
 * Firma › KI (issue #48): the providers this computer can use, an API key kept in the secret store
 * (never in the workspace, never sent back), and the model per step in this computer's settings.
 */
import { Router } from 'express';
import { resolve } from '../../llm/resolve.js';
import { keyedStates, keyName, subscriptions } from '../../llm/providers/index.js';
import { keepKey, KeyNotKept } from '../../llm/key-store.js';
import { claudeCli } from '../../llm/providers/claude-cli.js';
import { KEYED, type KeyedId } from '../../llm/providers/keyed.js';
import { PROVIDERS, readSettings, writeChoice, writeCli } from '../../llm/settings.js';
import { codexCli, codexStatus, refreshCodexModels } from '../../llm/providers/codex-cli.js';
import { tierModels, usable as codexUsable } from '../../llm/providers/codex-models.js';
import { isTerminalCli } from '../../platform/terminal.js';
import { confidentOf, isStepId, meets, STEP_IDS, STEPS } from '../../llm/steps.js';
import type { Provider, ProviderId } from '../../llm/provider.js';
import { secrets } from '../../secrets/secrets.js';
import type { AiProviderView, AiView } from '../../llm/view.js';
import { patchBody, RequestError } from '../books.js';

export const router = Router();

async function view({ recheck = false } = {}): Promise<AiView> {
  const [claudeReady, codexSignedIn] = await Promise.all([claudeCli.ready(), codexStatus()]);
  const catalog = codexSignedIn ? await refreshCodexModels({ force: recheck }) : undefined;
  const states = await keyedStates();
  const settings = readSettings();
  const usable: [Provider, ...Provider[]] = [...subscriptions(settings.cli), ...states.flatMap((s) => (s.provider ? [s.provider] : []))];
  const models = (p: Provider) => p.models.map((m) => ({ id: m.id, can: m.can }));
  const providers: AiProviderView[] = [
    { id: 'claude-cli', billing: 'subscription', state: claudeReady ? 'ready' : 'missing', models: models(claudeCli) },
    {
      id: 'codex-cli', billing: 'subscription', state: codexSignedIn ? 'ready' : codexSignedIn === false ? 'signedOut' : 'missing', models: models(codexCli),
      ...(codexSignedIn ? { tiers: tierModels(codexUsable(catalog)?.map((m) => m.slug)), ...(catalog ? { checkedAt: catalog.at } : {}) } : {}),
    },
    ...states.map((s): AiProviderView => ({
      id: s.spec.id, billing: 'key', state: s.provider ? 'set' : 'unset',
      models: s.provider ? models(s.provider) : [],
      ...(s.listError ? { listError: s.listError } : {}),
    })),
  ];
  const steps = STEP_IDS.map((id) => {
    const r = resolve(id, settings, usable);
    const d = resolve(id, { steps: {} }, usable);
    const choice = settings.steps[id];
    return {
      id, tier: STEPS[id].tier, needs: STEPS[id].needs, ...(confidentOf(id) !== undefined ? { confident: confidentOf(id) } : {}), ...(choice ? { choice } : {}),
      resolved: { provider: r.provider.id, model: r.model, source: r.source },
      standard: { provider: d.provider.id, model: d.model, ...(d.source === 'unserved' ? { unserved: true as const } : {}) },
    };
  });
  return {
    providers, steps, keysInApp: secrets.inApp(), keysWhere: Object.fromEntries(KEYED.map((s) => [s.id, secrets.where(keyName(s.id))])),
    ...(settings.cli ? { cli: settings.cli } : {}), askOther: settings.askOther === true,
  };
}

router.get('/api/ai', async (_req, res) => {
  res.json(await view());
});

/** «Nochmals prüfen»: Codex's models are read again from the signed-in account. */
router.post('/api/ai/codex/models', async (_req, res) => {
  res.json(await view({ recheck: true }));
});

/** «Die App fragt»: the CLI the steps ask first and «Im Terminal» starts (null: Claude Code), and whether to ask the other when it cannot answer. */
router.put('/api/ai/cli', async (req, res) => {
  const { cli, askOther } = patchBody(req.body, ['cli', 'askOther']);
  if (cli !== undefined && cli !== null && !isTerminalCli(cli)) throw new RequestError(400, 'cli: claude, codex oder null.');
  if (askOther !== undefined && typeof askOther !== 'boolean') throw new RequestError(400, 'askOther: true oder false.');
  writeCli({ ...(cli !== undefined ? { cli } : {}), ...(askOther !== undefined ? { askOther } : {}) });
  res.json(await view());
});

const isKeyed = (p: string): p is KeyedId => KEYED.some((s) => s.id === p);

/** The model for a step on this computer; `provider: null` gives the step back to its default. */
router.put('/api/ai/steps/:step', async (req, res) => {
  const step = req.params.step;
  if (!isStepId(step)) throw new RequestError(404, `Kein Schritt ${step}.`);
  const b = patchBody(req.body, ['provider', 'model']);
  if (b.provider === null) {
    writeChoice(step, null);
    return void res.json(await view());
  }
  if (typeof b.provider !== 'string' || !PROVIDERS.includes(b.provider as ProviderId) || typeof b.model !== 'string') throw new RequestError(400, 'provider und model erwartet.');
  const { providers } = await view();
  const offered = providers.find((p) => p.id === b.provider)?.models.find((m) => m.id === b.model);
  if (!offered || !meets(offered.can, step)) {
    throw new RequestError(400, `${b.model} kann den Schritt ${step} nicht ausführen.`, { code: 'aiModelUnfit', params: { model: b.model } });
  }
  writeChoice(step, { provider: b.provider as ProviderId, model: b.model });
  res.json(await view());
});

/** A key is checked against the provider's model list before it is kept; it is never sent back. */
router.put('/api/ai/keys/:provider', async (req, res) => {
  const id = req.params.provider;
  if (!isKeyed(id)) throw new RequestError(404, `Kein Anbieter ${id}.`);
  const key = patchBody(req.body, ['key']).key;
  if (key !== null && (typeof key !== 'string' || !key.trim())) throw new RequestError(400, 'key: ein Schlüssel, oder null zum Entfernen.');
  try {
    await keepKey(id, typeof key === 'string' ? key.trim() : null);
  } catch (e) {
    if (!(e instanceof KeyNotKept)) throw e;
    throw e.reason === 'where' ? new RequestError(409, e.message, { code: 'aiKeyWhere', params: { where: e.where! } })
      : e.reason === 'refused' ? new RequestError(400, e.message, { code: 'aiKeyRefused' })
      : new RequestError(503, e.message, { code: 'secretStore' });
  }
  res.json(await view());
});
