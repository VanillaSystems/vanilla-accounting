/**
 * What the kind of firm assumed, on both ways into the books (#385): the form sends the answers she
 * did not touch, the books keep them in onboarding.json (no format of the schema ladder), and the
 * conversation in the books shows them «angenommen» on the firm's card and in the summary, each with
 * its place by hand. The opening's words follow «Ausgangslage». Its own process: the desktop server
 * opens the books it creates.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { setupThread, type SetupCard } from '../src/onboarding/conversation.js';
import { emptyProgress, parseAssumed, stillAssumed, withAnswer, type Answer, type QuestionId, type SetupProgress } from '../src/onboarding/model.js';
import type { SetupFacts } from '../src/onboarding/facts.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';
import { PRESETS } from '../src/workspace/setup.js';

const home = mkdtempSync(join(tmpdir(), 'vanilla-assumed-'));
process.env.VANILLA_WORKSPACE = '';
process.chdir(home);
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
desktop.allowHost(`127.0.0.1:${port}`);
after(() => server.close());
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json() as any };
};

const TRADES = PRESETS.trades.answers;

test('the form\'s untouched answers reach the books as assumed; one she changed, or one the request claims falsely, does not; the setup still opens by itself', async () => {
  const root = join(home, 'Documents', 'Malerei');
  // She picked the trades preset, answered the method and basis, and changed «Ausgangslage» to a switch.
  const answers = { ...TRADES, start: 'switching' };
  const assumed = { by: 'trades', answers: { legalForm: 'GmbH', vatRegistered: 'yes', fiscalYear: 'calendar', sells: ['made', 'services'], foreignCustomers: 'no', imports: 'no', employees: 'none', ownerPaysPrivately: 'yes', privateUse: ['car', 'phone'], payouts: 'no' } };
  const made = await call('POST', '/api/desktop/create', {
    preset: 'trades', name: 'Malerei Test GmbH', uid: 'CHE-153.004.184', owner: 'Sandra Test', language: 'de', root, answers, banks: [{ bank: 'UBS', currency: 'CHF' }], assumed,
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const file = join(made.json.root, 'vanilla-accounting', 'onboarding.json');
  assert.ok(existsSync(file), 'onboarding.json written');
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  // employees: the request said «none», the books say «staff»: not kept as assumed.
  assert.deepEqual(Object.keys(kept.assumed.answers), ['legalForm', 'vatRegistered', 'fiscalYear', 'sells', 'foreignCustomers', 'imports', 'ownerPaysPrivately', 'privateUse', 'payouts']);
  assert.equal(kept.assumed.by, 'trades');
  assert.equal(kept.started, undefined, 'not marked as opened');

  const view = await call('GET', '/api/onboarding');
  assert.equal(view.status, 200);
  assert.equal(view.json.opensItself, true, 'the first start still opens the setup');
  assert.equal(view.json.facts.start, 'switching');
  assert.equal(view.json.facts.assumed.by, 'trades');
  assert.ok(!view.json.facts.assumed.answers.some((a: { key: string }) => a.key === 'start' || a.key === 'employees'));

  const steps = setupThread(view.json.progress, view.json.facts);
  const company = steps[0].card as Extract<SetupCard, { kind: 'company' }>;
  assert.equal(company.assumed?.by, 'trades');
  const go = Object.fromEntries(company.assumed!.answers.map((a) => [a.key, a.go?.section ?? null]));
  assert.equal(go.ownerPaysPrivately, 'banks');
  assert.equal(go.vatRegistered, 'vat');
  assert.equal(go.privateUse, 'rules');
  assert.equal(go.foreignCustomers, null);
});

test('an answer changed in the books since is no longer assumed', () => {
  const a = parseAssumed({ by: 'trades', answers: { employees: 'staff', privateUse: ['phone', 'car'], bogus: 'x', imports: 'maybe' } })!;
  assert.deepEqual(Object.keys(a.answers), ['employees', 'privateUse'], 'unknown questions and answers left out');
  assert.deepEqual(stillAssumed(a, { employees: 'staff', privateUse: ['car', 'phone'] }).map((x) => x.key), ['employees', 'privateUse']);
  assert.deepEqual(stillAssumed(a, { employees: 'none', privateUse: ['car'] }), []);
  assert.equal(parseAssumed({ by: 'custom', answers: {} }), undefined);
});

const AT = '2026-10-21T09:00:00.000Z';
const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  today: '2026-10-21', year: '2026',
  company: { name: 'Muster GmbH', uid: 'CHE-123.456.789', owner: 'Anna Muster', legalForm: 'GmbH', vat: EFFECTIVE_QUARTERLY },
  banks: [{ label: 'Bank', bank: 'raiffeisen', currency: 'CHF', account: '1020', iban: 'CH-TEST-IBAN' }], sources: [], opening: [], books: { payments: 0, receipts: 0, entries: 0 },
  partners: { clear: [], mixed: [], rare: [], ruled: 0 }, rules: 0,
  sells: { kinds: ['made', 'services'], accounts: { made: { purchase: '4000', sales: '3000' }, traded: { purchase: '4200', sales: '3200' }, services: { sales: '3400' } } },
  ...over,
});
const answered = (pairs: Partial<Record<QuestionId, string>>, p: SetupProgress = emptyProgress()): SetupProgress =>
  Object.entries(pairs).reduce<SetupProgress>((acc, [q, value], i) => withAnswer(acc, q as QuestionId, { value, at: `2026-10-21T09:0${i}:00.000Z` } as Answer), { ...p, created: AT });

test('the summary marks what was assumed, never as «deine Antwort»; once she answers «Was verkauft ihr?» it is hers', () => {
  const assumed = { by: 'trades' as const, answers: [{ key: 'sells' as const, value: ['made', 'services'] }, { key: 'employees' as const, value: 'staff' }] };
  const summaryOf = (p: SetupProgress) => setupThread(p, facts({ assumed })).at(-1)!.card as Extract<SetupCard, { kind: 'summary' }>;
  const done = { opening: 'later', receipts: 'later' };
  const before = summaryOf(answered({ company: 'ok', ...done }));
  assert.ok(!before.items.some((i) => i.what.key === 'onboarding.sum.sells'), 'sells stands once, as assumed');
  assert.deepEqual(before.assumed?.answers.map((a) => a.key), ['sells', 'employees']);
  const after = summaryOf(answered({ company: 'fix', vat: 'effective', sells: 'made+services', ...done }));
  assert.deepEqual(after.assumed?.answers.map((a) => a.key), ['employees']);
  assert.deepEqual(after.items.find((i) => i.what.key === 'onboarding.sum.sells')?.origin, 'answer');
});

test('the opening\'s words follow «Ausgangslage»: a switch takes last year\'s balance sheet, a new firm its capital', () => {
  const opening = (start: SetupFacts['start']) => setupThread(answered({ company: 'ok' }), facts({ start })).find((s) => s.id === 'opening')!.say[0].key;
  assert.equal(opening('switching'), 'onboarding.s.openingNoneSwitching');
  assert.equal(opening('new'), 'onboarding.s.openingNone');
  assert.equal(opening(undefined), 'onboarding.s.openingNone');
});
