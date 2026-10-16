/**
 * A report asked for in the sidebar (src/assistant/changes.ts kind `report`, src/server/routes/
 * assistant.ts, src/reports/figures.ts): the AI writes a spec, never a figure; the app runs it
 * and puts the run on the answer's card; a spec with a digit in its comment or an account the
 * chart lacks is refused with its reason and nothing is made; words that state a figure the run
 * did not produce are withdrawn. On the real API server with the claude stub, on a copy of the demo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { accountsOf } from '../src/workspace/reads.js';
import { loadInvoices } from '../src/invoices/store.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { ChangesError, changesIn } from '../src/assistant/changes.js';
import { assistantSystem } from '../src/assistant/claude.js';
import { parseSpec } from '../src/reports/spec.js';
import { runReport } from '../src/reports/run.js';
import { numbersIn, strayFigures } from '../src/reports/figures.js';
import type { AssistantEvent, Conversation, Turn } from '../src/types/assistant.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

const REPO = process.cwd();
const log = mkdtempSync(join(tmpdir(), 'assistant-report-'));
const CHANGES = join(log, 'changes.json');
const TEXT = join(log, 'text.txt');
const ws = workspaceAt(DEMO_ROOT);
const names = Object.fromEntries((accountsOf(ws) as Array<{ number: string; name: string }>).map((a) => [a.number, a.name]));
const Q3 = parsePeriod('2026-Q3', '2026-10-16')!;

const SPEC = {
  title: 'Aufwand nach Konto', period: '2026-Q3',
  sections: [{ source: 'entries', filter: { accounts: ['6000-6999'] }, group: 'account', columns: ['date', 'text', 'account', 'net', 'tax', 'amount'] }],
  comment: 'Im Zeitraum {period}: {count} Buchungen, zusammen {total}.',
};
const direct = () => { const p = parseSpec(SPEC, '2026-10-16'); assert.ok(p.ok); return runReport(p.value, { books: loadBooks(ws), invoices: loadInvoices(ws).invoices, names }, Q3); };

let api: ApiServer;
before(async () => {
  api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: CHANGES, CLAUDE_STUB_TEXT: TEXT });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
});
after(() => { api?.stop(); rmSync(log, { recursive: true, force: true }); });

async function ask(changes: unknown[], text = 'Hier ist der Bericht.') {
  writeFileSync(CHANGES, JSON.stringify(changes));
  writeFileSync(TEXT, text);
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Spesen im Q3 nach Konto', language: 'de', context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const id = (events[0] as { id: string }).id;
  return ((await api.send('GET', `/api/assistant/${id}`)).json as unknown as Conversation).turns.at(-1) as Extract<Turn, { role: 'ai' }>;
}

test('the block\'s report is read as a spec; one whose comment holds a figure is refused with the reason', () => {
  const [c] = changesIn(`Bericht.\n\`\`\`vanilla-changes\n${JSON.stringify([{ kind: 'report', spec: SPEC }])}\n\`\`\``);
  assert.equal(c.kind, 'report');
  assert.deepEqual(c.kind === 'report' && c.spec.sections[0].filter.accounts, [{ from: '6000', to: '6999' }]);
  assert.throws(() => changesIn(`\`\`\`vanilla-changes\n${JSON.stringify([{ kind: 'report', spec: { ...SPEC, comment: 'Etwa 4200 Franken' } }])}\n\`\`\``),
    (e: unknown) => e instanceof ChangesError && JSON.stringify(e.refusal) === JSON.stringify({ code: 'report', params: { refusal: { code: 'figureInComment', params: { text: '4200' } } } }));
});

test('the app runs the spec: the card carries the run\'s figures, the first rows only, and the answer ends with the app\'s line', async () => {
  const turn = await ask([{ kind: 'report', spec: SPEC }]);
  assert.equal(turn.refused, undefined, turn.refused);
  const made = turn.changes![0];
  assert.equal(made.change.kind, 'report');
  assert.equal(made.undo, undefined, 'a report changes nothing in the books');
  const card = made.note!.report!;
  const all = direct();
  assert.deepEqual(card.totals, all.totals, 'the card\'s totals are those of every row');
  assert.deepEqual(card.sections[0].groups.map((g) => g.totals), all.sections[0].groups.map((g) => g.totals));
  assert.equal(card.sections[0].groups.reduce((n, g) => n + g.rows.length, 0), Math.min(5, all.count));
  assert.ok(turn.text.startsWith('Hier ist der Bericht.'), 'words without a figure stay');
  assert.equal(turn.text.trim().split('\n\n').at(-1), 'Der Bericht steht unten: jede Zahl darin hat die App aus den Büchern gerechnet.');
});

test('an answer that states a figure the run did not produce is withdrawn; the report stays', async () => {
  const turn = await ask([{ kind: 'report', spec: SPEC }], 'Der Aufwand im Q3 war rund CHF 4\'321.50, verteilt auf 2026 und die Konten 6000 bis 6999.');
  assert.ok(turn.changes?.[0].note?.report, 'the report is made');
  assert.ok(turn.withdrawn?.includes('4\'321.50'), 'the model\'s words are kept aside');
  assert.ok(turn.text.startsWith('Die Antwort nannte Zahlen, die nicht aus dem Bericht stammen'), turn.text);
  const right = direct().totals[0].amount.toFixed(2);
  const kept = await ask([{ kind: 'report', spec: SPEC }], `Zusammen ${right}, am 30.09.2026 in Q3.`);
  assert.equal(kept.withdrawn, undefined, 'a figure the run produced, a date and a quarter are no stray figures');
});

test('a filter on an account the chart lacks refuses the answer with its reason; nothing is made', async () => {
  const turn = await ask([{ kind: 'report', spec: { ...SPEC, sections: [{ source: 'entries', filter: { accounts: ['6599'] } }] } }]);
  assert.equal(turn.changes, undefined);
  assert.deepEqual(turn.refusal, { code: 'report', params: { refusal: { code: 'unknownAccount', params: { account: '6599' } } } });
});

test('numbers in words: amounts in Swiss and plain spelling count, dates and quarters do not', () => {
  assert.deepEqual(numbersIn('CHF 1\'234.50, 12 Buchungen, 3,5 %, am 16.10.2026, 2026-07-01, Q3').map((n) => n.cents), [123450, 1200, 350]);
  const r = direct();
  assert.deepEqual(strayFigures(`Total ${r.totals[0].amount}, ${r.count} Zeilen, Konto 6570`, [r], Object.keys(names)), []);
  assert.deepEqual(strayFigures('Konto 6510', [r]), ['6510'], 'without the chart an account number is a figure');
  assert.deepEqual(strayFigures('rund 99999.99', [r]), ['99999.99']);
});

test('the prompt describes the report spec and forbids every figure in the answer and the comment', () => {
  const prompt = assistantSystem('de', '2850', '');
  assert.match(prompt, /"kind":"report","spec":\{"title"/);
  assert.match(prompt, /In your answer never state an amount, a count or any other figure of the report/);
  assert.match(prompt, /the app refuses a comment with a digit/);
  const example = /\{"kind":"report","spec":(\{.*?\})\}\. You write/.exec(prompt)!;
  assert.ok(parseSpec(JSON.parse(example[1])).ok, 'the prompt\'s own example is a spec the app reads');
});
