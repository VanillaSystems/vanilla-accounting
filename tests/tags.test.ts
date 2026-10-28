/**
 * Reporting dimensions (#127): the workspace declares them in belege.workspace.yaml, a booking
 * carries at most one value of each in `tags`, a rule sets them (`then.tags`), the Erfolgsrechnung
 * and the custom reports filter and group by them, and the books' format makes an older app refuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { dimensionId, matchesTags, offeredValues, parseTags, readDimensions, type Dimension } from '../src/books/tags.js';
import { parseManifest } from '../src/workspace/manifest.js';
import { patchManifestText } from '../src/workspace/manifest-write.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, SchemaTooNewError, climb } from '../src/workspace/schema.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { parseRule, ruleWords, type RuleFacts } from '../src/booking/rules.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { withHandRule } from '../src/saving/hand-rule.js';
import { emptyForm, handRuleOf } from '../src/app/areas/company/hand-rule-model.js';
import { incomeColumns, reportView, slicedBooks } from '../src/app/areas/reports/model.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { checkSpec, parseSpec } from '../src/reports/spec.js';
import { runReport } from '../src/reports/run.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, Index, JournalEntry } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'tags-runs-'));

const DIMENSIONS = `dimensions:
  - id: projekt
    label: Projekt
    values:
      - { value: alpha, label: Website Alpha }
      - beta
      - { value: alt, active: false }
  - id: standort
    label: Standort
`;
const dims = (): Dimension[] => readDimensions(parseDocument(DIMENSIONS).toJS().dimensions, (m) => { throw new Error(m); });
const manifestText = () => readFileSync(join(DEMO_ROOT, 'belege.workspace.yaml'), 'utf8');

test('the manifest declares dimensions: a value is a text or { value, label, active }; a manifest without them has none', () => {
  assert.equal(parseManifest(manifestText(), 'm').dimensions, undefined);
  const m = parseManifest(`${manifestText()}${DIMENSIONS}`, 'm');
  assert.deepEqual(m.dimensions, [
    { id: 'projekt', label: 'Projekt', values: [{ value: 'alpha', label: 'Website Alpha', active: true }, { value: 'beta', active: true }, { value: 'alt', active: false }] },
    { id: 'standort', label: 'Standort', values: [] },
  ]);
  const bad = (yaml: string, why: RegExp) => assert.throws(() => parseManifest(`${manifestText()}${yaml}`, 'm'), why);
  bad('dimensions:\n  - { id: Projekt, label: P }\n', /dimensions\[0\]\.id "Projekt" must be lower-case/);
  bad('dimensions:\n  - { id: p, label: P }\n  - { id: p, label: Q }\n', /p is listed twice/);
  bad('dimensions:\n  - { id: p }\n', /label must be a non-empty text/);
  bad('dimensions:\n  - { id: p, label: P, values: [a, a] }\n', /the value a is listed twice/);
});

test('a new dimension\'s id comes from its name, readable and unique', () => {
  assert.equal(dimensionId('Kostenstelle', []), 'kostenstelle');
  assert.equal(dimensionId('Standort Zürich', []), 'standort-zurich');
  assert.equal(dimensionId('Projekt', ['projekt']), 'projekt-2');
  assert.equal(dimensionId('2026', []), 'dimension');
});

test('Firma › Dimensionen writes the whole list into the manifest, keeping its comments; an empty list removes the block', () => {
  const text = `# a comment that stays\n${manifestText()}`;
  const { text: out, manifest } = patchManifestText(text, { dimensions: dims() }, 'm');
  assert.match(out, /^# a comment that stays/);
  assert.deepEqual(manifest.dimensions, dims());
  assert.match(out, /values:\n\s+- value: alpha\n\s+label: Website Alpha\n\s+- beta\n\s+- value: alt\n\s+active: false/);
  assert.equal(patchManifestText(out, { dimensions: [] }, 'm').manifest.dimensions, undefined);
});

test('a booking\'s tags name declared dimensions only, one short value each; an empty value drops the dimension', () => {
  const d = dims();
  assert.deepEqual(parseTags({ standort: 'Bern', projekt: ' alpha ' }, d), { ok: true, tags: { projekt: 'alpha', standort: 'Bern' } });
  assert.deepEqual(parseTags({ projekt: '' }, d), { ok: true, tags: undefined });
  assert.deepEqual(parseTags({ kunde: 'x' }, d), { ok: false, refusal: { code: 'tagDimension', params: { dimension: 'kunde' } } });
  assert.deepEqual(parseTags({ projekt: 'x'.repeat(65) }, d), { ok: false, refusal: { code: 'tagValue', params: { dimension: 'projekt', value: 'x'.repeat(65) } } });
  assert.deepEqual(parseTags(['alpha'], d), { ok: false, refusal: { code: 'tagShape' } });
});

test('a field offers the active declared values, then the values bookings carry that the list lacks; a filter keeps any of a dimension\'s values, \'\' the bookings without one', () => {
  const [projekt] = dims();
  assert.deepEqual(offeredValues(projekt, [{ tags: { projekt: 'gamma' } }, { tags: { projekt: 'alt' } }, {}]).map((v) => v.value), ['alpha', 'beta', 'gamma']);
  assert.equal(matchesTags({ projekt: 'alpha' }, { projekt: ['alpha', 'beta'] }), true);
  assert.equal(matchesTags({ projekt: 'alpha', standort: 'Bern' }, { projekt: ['alpha'], standort: ['Zug'] }), false, 'every dimension named must hold');
  assert.equal(matchesTags(undefined, { projekt: [''] }), true);
  assert.equal(matchesTags({ projekt: 'beta' }, { projekt: [''] }), false);
});

test('books schema 4: the step from 3 changes no record and runs twice to the same result; an app of schema 3 refuses books of schema 4', () => {
  assert.equal(BOOKS_SCHEMA, 6);
  const clone = (d: Record<string, unknown>) => structuredClone(d);
  const books = { schema: 3, journalEntries: [{ id: 'e1', tags: { projekt: 'alpha' } }], config: { closedThrough: '2026-03-31' } };
  const once = climb<Record<string, unknown>>(books, 3, BOOKS_SCHEMA, BOOKS_MIGRATIONS, 'ledger.json', clone);
  const twice = climb<Record<string, unknown>>(once, 3, BOOKS_SCHEMA, BOOKS_MIGRATIONS, 'ledger.json', clone);
  assert.deepEqual(once, books);
  assert.deepEqual(twice, books);
  assert.throws(() => climb(once, 4, 3, BOOKS_MIGRATIONS, 'ledger.json', clone), (e: Error) => e instanceof SchemaTooNewError && /schema 4; this version of the app reads up to 3/.test(e.message));
});

test('tags on an open entry survive a save and a load, and a sealed demo still verifies with books written at the current schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tags-books-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const open = books.journalEntries.find((e) => e.date > (books.config.closedThrough ?? ''))!;
  open.tags = { projekt: 'alpha' };
  saveBooks(ws, books);
  const again = loadBooks(ws);
  assert.deepEqual(again.journalEntries.find((e) => e.id === open.id)?.tags, { projekt: 'alpha' });
  assert.equal(JSON.parse(readFileSync(ws.paths.ledger, 'utf8')).schema, BOOKS_SCHEMA);
});

// ─── Rules ───────────────────────────────────────────────────────────────────

const facts: RuleFacts = { account: () => true, vat: () => 'taken', counterparty: () => true, dimension: (id) => ['projekt', 'standort'].includes(id) };

test('a rule\'s then.tags rides on its booking: declared dimensions only, refused without a booking, said in its plain line', () => {
  const ok = parseRule({ id: 'r', when: { text: 'Acme' }, then: { account: '6570', vat: 'I81', tags: { projekt: 'alpha' } } }, facts);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.rule.then.kind === 'book' && ok.rule.then.booking.tags, { projekt: 'alpha' });
  const asks = parseRule({ id: 'r', when: { text: 'Acme' }, then: { ask: 'Welches Projekt?', account: '6570', vat: 'I81', tags: { projekt: 'beta' } } }, facts);
  assert.deepEqual(asks.ok && asks.rule.then.kind === 'ask' && asks.rule.then.booking?.tags, { projekt: 'beta' });
  assert.deepEqual(parseRule({ id: 'r', when: { text: 'Acme' }, then: { account: '6570', vat: 'I81', tags: { kunde: 'x' } } }, facts), { ok: false, refusal: { code: 'dimension', params: { dimension: 'kunde' } } });
  assert.deepEqual(parseRule({ id: 'r', when: { text: 'Acme' }, then: { ask: 'Was?', tags: { projekt: 'alpha' } } }, facts), { ok: false, refusal: { code: 'outcome' } });
  assert.deepEqual(parseRule({ id: 'r', when: { text: 'Acme' }, then: { account: '6570', vat: 'I81', tags: { projekt: 'alpha' } } }, { ...facts, dimension: undefined }), { ok: false, refusal: { code: 'dimension', params: { dimension: 'projekt' } } });
  const w = (k: string, v: Record<string, string>) => `${k}(${Object.values(v).join('|')})`;
  const line = ruleWords({ rule: ok.ok ? ok.rule : (undefined as never) }, { account: () => undefined, business: () => undefined, money: String, tag: (d, v) => `${d}=${v}` }, w as never).line;
  assert.match(line, /rules\.say\.tags\(projekt=alpha\)$/);
});

/** The demo with dimensions and a rule that tags. */
function company(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'tags-ws-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  appendFileSync(join(dir, 'belege.workspace.yaml'), DIMENSIONS);
  mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'rules', 'booking.guide.yaml'), `process: booking
steps:
  classify:
    rules:
      - id: acme-alpha
        when: { text: "ACME Hosting" }
        then: { account: "6570", vat: I81, tags: { projekt: alpha, standort: Bern } }
        source: wish 2026-10-23
      - id: acme-private
        when: { text: "ACME Mobile" }
        then: { account: "6570", vat: I81, private: 50, tags: { projekt: beta } }
        source: wish 2026-10-23
`);
  return workspaceAt(dir);
}

const tx = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>): BankTransaction =>
  ({ bank: 'Raiffeisen', date: '2026-08-14', amount: 50, currency: 'CHF', direction: 'DBIT', description: 'Bank text', ...t });

test('a rule that tags books every line it makes with its tags, the private share too', async () => {
  const ws = company();
  const receipt = (id: string) => ({ id, filename: `${id}.pdf`, extractedText: 'Beleg mit genug Text', hasSwissVat: true });
  const books = {
    transactions: [tx({ ref: 'A1', description: 'ACME Hosting AG' }), tx({ ref: 'A2', description: 'ACME Mobile', amount: 80 })],
    receipts: [receipt('r1'), receipt('r2')], mappings: [{ transactionRef: 'A1', receiptId: 'r1' }, { transactionRef: 'A2', receiptId: 'r2' }],
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
  await classifyTransactions(books, books.transactions, { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  const of = (ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.amount, e.rule, e.tags]);
  assert.deepEqual(of('A1'), [['6570', 50, 'acme-alpha', { projekt: 'alpha', standort: 'Bern' }]]);
  assert.deepEqual(of('A2').map((l) => l[3]), [{ projekt: 'beta' }, { projekt: 'beta' }]);
});

test('a hand-made rule carries the tags typed in its form into then.tags', () => {
  const made = handRuleOf({ ...emptyForm(), match: 'text', text: 'ACME', account: '6570', vat: 'I81', tags: { projekt: ' alpha ', standort: '' } });
  assert.ok(made.ok);
  assert.deepEqual(made.ok && made.rule.tags, { projekt: 'alpha' });
  const text = withHandRule('', made.ok ? made.rule : (undefined as never), '2026-10-23');
  assert.match(text, /then: \{ account: "6570", vat: I81, tags: \{ projekt: alpha \} \}/);
});

// ─── Reports ─────────────────────────────────────────────────────────────────

const entry = (id: string, accountDebit: string, accountCredit: string, amount: number, tags?: JournalEntry['tags']): JournalEntry =>
  ({ id, transactionRef: id, date: '2026-08-10', accountDebit, accountCredit, amount, ...(tags && { tags }) });

const booksWith = (entries: JournalEntry[]): Index => ({ receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: entries, config: {} });
const NAMES = { 1020: 'Bank', 3200: 'Handelserlöse', 6570: 'Informatikaufwand', 6500: 'Büro' };
const AUGUST = parsePeriod('2026-08', '2026-10-23')!;

test('the Erfolgsrechnung filtered by tags reads only the bookings that carry them; its columns per value add up to the report of all bookings', () => {
  const books = booksWith([
    entry('s1', '1020', '3200', 1000, { projekt: 'alpha' }),
    entry('s2', '1020', '3200', 400, { projekt: 'beta' }),
    entry('c1', '6570', '1020', 300, { projekt: 'alpha' }),
    entry('c2', '6500', '1020', 50),
  ]);
  const result = (b: Index) => reportView('income', b, AUGUST, NAMES, false).headline.value;
  assert.equal(result(books), 1050);
  assert.equal(result(slicedBooks(books, { projekt: ['alpha'] })), 700);
  assert.equal(result(slicedBooks(books, { projekt: ['alpha', 'beta'] })), 1100);
  assert.equal(result(slicedBooks(books, { projekt: [''] })), -50, 'the bookings without a project');
  const [projekt] = dims();
  const cols = incomeColumns(books, AUGUST, NAMES, projekt);
  assert.deepEqual(cols.map((c) => [c.value, c.view.headline.value]), [['alpha', 700], ['beta', 400], ['', -50]]);
  assert.equal(cols.reduce((n, c) => n + c.view.headline.value, 0), result(books));
});

test('a custom report filters bookings by tags and groups them by a dimension; a dimension the firm lacks is refused, and only bookings take tags', () => {
  const raw = { title: 'Projekte', period: '2026-08', sections: [{ source: 'entries', filter: { accounts: ['3000-6999'], tags: { projekt: ['alpha', ''] } }, group: 'tag:projekt' }] };
  const parsed = parseSpec(raw, '2026-10-23');
  assert.ok(parsed.ok);
  const spec = parsed.ok ? parsed.value : (undefined as never);
  assert.equal(checkSpec(spec, { accounts: NAMES, takesCode: () => true, dimensions: dims() }), undefined);
  assert.deepEqual(checkSpec(spec, { accounts: NAMES, takesCode: () => true }), { code: 'unknownDimension', params: { dimension: 'projekt' } });
  const books = booksWith([entry('s1', '1020', '3200', 1000, { projekt: 'alpha' }), entry('s2', '1020', '3200', 400, { projekt: 'beta' }), entry('c2', '6500', '1020', 50)]);
  const r = runReport(spec, { books, invoices: [], names: NAMES, dimensions: dims() }, AUGUST);
  assert.deepEqual(r.sections[0].groups.map((g) => [g.key, g.label, g.totals[0].amount]), [['alpha', 'Website Alpha', 1000], ['', '', 50]]);
  assert.deepEqual(parseSpec({ ...raw, sections: [{ source: 'payments', group: 'tag:projekt' }] }, '2026-10-23'), { ok: false, refusal: { code: 'notForSource', params: { source: 'payments', what: 'tag:projekt' } } });
});
