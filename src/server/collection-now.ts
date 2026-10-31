/**
 * How receipts reach the app now, for the AI sidebar's message (src/server/routes/assistant.ts):
 * every source with whether it is switched on, whether its password is stored (never the password)
 * and when it last delivered, and whether the phone is switched on. The AI answers «what is set
 * up?» from this, and sets up what is missing instead of sending the person to the settings: from
 * the channels the app serves (ways.ts) and what it can see of the person's mail (mail-evidence.ts).
 */
import type { Workspace } from '../workspace/workspace.js';
import { APP_ROOT } from '../workspace/workspace.js';
import { sources } from '../platform/sources/index.js';
import { secretKey, type SourceVerdict } from '../platform/sources/model.js';
import { feedState, readLedger } from '../platform/sources/ledger.js';
import { secrets } from '../secrets/secrets.js';
import { phoneToken } from './phone.js';
import { wordsIn } from '../export/texts.js';
import { collectChannels } from '../platform/sources/ways.js';
import { mailEvidenceNow, type Seen } from './mail-evidence.js';

type T = ReturnType<typeof wordsIn>['t'];

async function sourceLine(ws: Pick<Workspace, 'paths'>, v: SourceVerdict, t: T, language: string): Promise<string> {
  if (v.kind === 'invalid') return `- a source with errors (${v.problems.length}): the person sees them in ${t('area.company')} › ${t('company.sources')}`;
  const d = v.decl;
  const what = d.reach.mail ? `mailbox ${d.reach.mail.account} on ${d.reach.mail.host}` : d.reach.macMail ? `the account ${d.reach.macMail.account} of the Mail app` : d.reach.api ? `the API ${d.reach.api.base}` : d.reach.web ? `a browser session on ${d.reach.web.open.map((p) => p.host).filter((h, i, a) => a.indexOf(h) === i).join(', ')}` : 'source';
  const channels = (['mail', 'api'] as const).filter((c) => d.reach[c]);
  const stored = await Promise.all(channels.map(async (c) => !!(await secrets.get(secretKey(d.id, c)))));
  const ledger = readLedger(ws, d.id);
  const last = d.feeds.map((f) => feedState(ledger, f.id).last).filter(Boolean).sort().at(-1);
  return [
    `- «${d.label[language] ?? d.label.en ?? d.id}» (${what}, by ${d.origin === 'app' ? 'the app' : 'the company'})`,
    v.kind === 'ready' ? 'switched on' : `a draft waiting for «${t('sources.approve')}»`,
    ...channels.map((c, i) => `${c === 'mail' ? 'password' : 'token'} ${stored[i] ? 'stored' : 'missing'}`),
    `sources/${d.id}/ (${d.code.kind === 'app' ? `code: app:${d.code.id}` : `own code ${d.code.entry}`})`,
    `fetched ${d.feeds.map((f) => f.every).join('/')}`,
    last ? `last delivered ${last.slice(0, 10)}` : 'nothing delivered yet',
  ].join('; ');
}

/** `receipts` feed the evidence (src/server/mail-evidence.ts): counts and domains, never a text. */
export async function collectionNow(ws: Workspace, language: string, receipts: Seen['receipts'] = []): Promise<string> {
  const { t } = wordsIn(language);
  const place = (s: string) => s.replace('{sources}', `${t('area.company')} › ${t('company.sources')}`);
  const all = sources(ws, APP_ROOT);
  const lines = await Promise.all(all.map((v) => sourceLine(ws, v, t, language)));
  return [
    'How receipts reach the app now (the collection checks every hour and fetches each source as often as it says):',
    ...(lines.length ? lines : ['- no source is connected yet']),
    `- the phone: ${phoneToken() ? 'switched on' : 'not switched on'}`,
    `- dropping files on ${t('area.receipts')}, and the bank statements on ${t('area.bank')}: always possible`,
    'The channels a source can reach the receipts through, most preferred first (find out first which fit the person; propose the most preferred one that fits and is available here, and build the source with them):',
    ...collectChannels(APP_ROOT).map((c, i) => `${i + 1}. ${c.id}: ${c.what}; fits ${c.fits}; needs ${place(c.needs)}; ${c.bind ? `the app's code binds it: code: app:${c.bind}` : 'the source\'s own code in the workspace'}; ${c.available ? 'available here' : 'not available here: never offer or mention it; propose an available one that fits'}`),
    '',
    ...(await mailEvidenceNow(ws, receipts)),
  ].join('\n');
}
